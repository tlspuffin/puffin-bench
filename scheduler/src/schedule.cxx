#include "schedule.hxx"
#include <iostream>
#include <sstream>
#include <stack>
#include <unordered_set>
#include <algorithm>
#include <fcntl.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <rapidjson/filereadstream.h>
#include <rapidjson/error/en.h>

#define RAPIDJSON_ASSERT(x) { throw std::runtime_error(x); }

#define SCRIPT_PATH "../scripts"
#define RUN_PATH "../runs"

uint64_t parseTimeout(const std::string& str) {
    if (str.empty()) return 0;
    char unit = str.back();
    int value = std::stoi(str.substr(0, str.size() - 1));
    if (unit == 'm') return value * 60;
    if (unit == 's') return value;
    return value;
}

void Schedule::ExtractStep(Schedule::Step* step, rapidjson::Value const& entry) {
  if (entry.HasMember("args") && entry["args"].IsString())
    step->args_ = entry["args"].GetString();
  if (entry.HasMember("nbcpu") && entry["nbcpu"].IsInt())
    step->nb_cpu_ = static_cast<uint32_t>(entry["nbcpu"].GetInt());
  if (entry.HasMember("retry") && entry["retry"].IsInt())
    step->nb_retry_ = static_cast<uint32_t>(entry["retry"].GetInt());
  if (entry.HasMember("maxtime") && entry["maxtime"].IsString())
    step->timeout_ = parseTimeout(entry["maxtime"].GetString());
}

std::list<Schedule::Step*> Schedule::BuildStepsFromJson(const rapidjson::Value& root) {
  std::vector<Step*> all_steps;
  std::list<Step*> parent_stack;
  std::list<Step*> current_stack;
  std::list<Step*> root_steps;
  bool is_first_task = true;

  if (!root.HasMember("flow") || !root["flow"].IsArray()) {
    throw std::runtime_error("Invalid or missing 'flow' in JSON");
    return {};
  }

  uint64_t task_id = next_task_id_++;
  uint64_t step_id = 0;

  const rapidjson::Value& flow = root["flow"];

  for (rapidjson::SizeType i = 0; i < flow.Size(); ++i) {
    const rapidjson::Value& task = flow[i];

    if (!task.HasMember("task") || !task["task"].IsString()) {
      continue;
    }

    const std::string& task_name = task["task"].GetString();
    current_stack.clear();

    Step* step = new Step(task_name);
    ExtractStep(step, task);

    if (task.HasMember("run") && task["run"].IsArray()) {
      const rapidjson::Value& run_array = task["run"];

      Step* first_step = step;
      Step* last_step = step;
      for (rapidjson::SizeType j = 0; j < run_array.Size(); ++j) {
        const rapidjson::Value& run = run_array[j];
        if (j != 0) {
          step->next_ = new Step(task_name);
          step->next_->previous_ = step;
          step = step->next_;
          step->CloneParameters(*(step->previous_));
        }
        step->task_id_ = task_id;
        step->step_id_ = step_id;
        step->rank_id_ = j;
        step->run_path = run_path_ + "/" + std::to_string(step->task_id_);
        step->stdout = step->run_path + "/.output/stdout." + std::to_string(step->step_id_) + 
            "-" + std::to_string(step->rank_id_) + ".txt";
        step->stderr = step->run_path + "/.output/stderr." + std::to_string(step->step_id_) + 
            "-" + std::to_string(step->rank_id_) + ".txt";
        
        ExtractStep(step, run);

        step->depend_from_ = parent_stack;
        current_stack.push_back(step);
        all_steps.push_back(step);

        last_step = step;
        step->next_ = first_step;
      }
      first_step->previous_ = last_step;
    } else {
      step->task_id_ = task_id;
      step->step_id_ = step_id;
      step->run_path = run_path_ + "/" + std::to_string(step->task_id_);
      step->stdout = step->run_path + "/.output/stdout." + std::to_string(step->step_id_) + 
          "-0.txt";
      step->stderr = step->run_path + "/.output/stderr." + std::to_string(step->step_id_) + 
          "-0.txt";
      step->depend_from_ = parent_stack;
      current_stack.push_back(step);
      all_steps.push_back(step);
    }

    for(auto& parent : parent_stack) {
      parent->dependencies_.insert(
          parent->dependencies_.end(),
          current_stack.rbegin(), current_stack.rend()
      );
    }

    if (is_first_task) {
      root_steps = current_stack;
      is_first_task = false;
    }

    parent_stack = current_stack;

    step_id++;
  }

  return root_steps;
}

Schedule::Schedule(uint64_t maxCPU) 
    : script_path_(), run_path_(), next_task_id_(1), 
    maxCPU_(maxCPU), threadRunning_(false)
{
  char* path = NULL;
  path = realpath(SCRIPT_PATH, NULL);
  script_path_ = path;
  free(path);
  path = realpath(RUN_PATH, NULL);
  run_path_ = path;
  free(path);
}

Schedule::~Schedule() {
  lockThread_.lock();
  if (threadRunning_) {
    threadRunning_ = false;
    if (thread_.joinable()) {
      lockThread_.unlock();
      thread_.join();
      lockThread_.lock();
    }
  }
  for(Schedule::Step* rootStep : tasks_) {
    try {
      DeleteTask(rootStep);
    } catch(std::exception const& e) {
      std::cerr << "DeleteTask exception: " << e.what() << std::endl;
    }
  }

  lockThread_.unlock();
}

bool Schedule::AddJob(std::string tasksList, std::vector<std::string> files) {
  FILE* fTasksList = fopen(tasksList.c_str(), "r");
  char buffer[65536];
  rapidjson::FileReadStream isTasks(fTasksList, buffer, sizeof(buffer));

  rapidjson::Document stepsJSON;
  stepsJSON.ParseStream(isTasks);
  fclose(fTasksList);

  if (stepsJSON.HasParseError()) {
    throw std::runtime_error(
        std::string("Parsing JSON Error : ") +
        rapidjson::GetParseError_En(stepsJSON.GetParseError()) +
        " byte " + std::to_string(stepsJSON.GetErrorOffset())
    );
  }

  std::list<Schedule::Step*> steps = BuildStepsFromJson(stepsJSON);

  lockThread_.lock();

  for(Schedule::Step* step : steps) {
    tasks_.push_back(step);
    steps_.push_back(step);
  }
  
  if (!threadRunning_) {
    if (thread_.joinable()) {
      lockThread_.unlock();
      thread_.join();
      lockThread_.lock();
    }
    threadRunning_ = true;
    thread_ = std::thread(&Schedule::ScheduleLoop, this);
  }
  lockThread_.unlock();

  return true;
}

void Schedule::DeleteTask(Schedule::Step* rootStep) {
  if (!rootStep->depend_from_.empty()) {
    throw std::runtime_error("Trying to delete a non-root task: name=" +
        rootStep->name_ + ", uuid=" + std::to_string(rootStep->uuid_));
  }
  std::unordered_set<Schedule::Step*> stepCleared;
  std::stack<Schedule::Step*> stepToClear;
  stepToClear.push(rootStep);
  while (!stepToClear.empty()) {
    Schedule::Step* step = stepToClear.top();
    stepToClear.pop();
    if (!stepCleared.insert(step).second) {
      continue;
    }
    for(Schedule::Step* childStep : step->dependencies_) {
      stepToClear.push(childStep);
    }
    delete step;
  }
}

std::list<Schedule::Step*> Schedule::SearchTaskToRun(uint64_t nbCPUsFree, std::list<Schedule::Step*>& tasks) {
  std::list<Schedule::Step*> result;

  for(Schedule::Step* step : tasks) {
    uint64_t nbCPUsRequired = step->nb_cpu_;
    if ((step->state_ == 1) || (nbCPUsRequired > nbCPUsFree)) {
      continue;
    }
    nbCPUsFree -= nbCPUsRequired;
    result.push_back(step);
  }

  return result;
}

inline std::vector<uint64_t> AssignCPU(std::vector<bool>& cpusFree, uint64_t nbCPU) {
  std::vector<uint64_t> result;
  for (size_t i=0; i<cpusFree.size(); ++i) {
    if (cpusFree[i]) {
      cpusFree[i] = false;
      result.push_back(i);
      if (--nbCPU == 0) {
        break;
      };
    }
  }
  return result;
}

inline void ReleaseCPU(uint64_t& nbCPUsFree, std::vector<bool>& cpusFree, std::vector<uint64_t>& cpus) {
  for(uint64_t index: cpus) {
    cpusFree[index] = true;
  }
  nbCPUsFree += cpus.size();
}

inline bool RedirectOutput(int outhandler, int errhandler) {
  return ((close(1) == 0) && (dup(outhandler) == 1) && (close(outhandler) == 0) &&
      (close(2) == 0) && (dup(errhandler) == 2) && (close(errhandler) == 0));
}

pid_t Schedule::Execute(Schedule::Step* step) {
  if ((step->step_id_ == 0) && (step->rank_id_ == 0)) {
    if (mkdir(step->run_path.c_str(), 0777) != 0) {
      /*throw std::runtime_error(
          std::string("mkdir failed: errno=") +
          std::to_string(errno) +
          " (" + std::strerror(errno) + ")"
      );*/
    }
    if (mkdir(std::string(step->run_path + "/.output").c_str(), 0777) != 0) {
      /*throw std::runtime_error(
          std::string("mkdir failed: errno=") +
          std::to_string(errno) +
          " (" + std::strerror(errno) + ")"
      );*/
    }
  }
  int outhandler = open(step->stdout.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 00660);
  if (outhandler == -1) {
    throw std::runtime_error(
        std::string("open stdout failed: errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }
  int errhandler = open(step->stderr.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 00660);
  if (errhandler == -1) {
    throw std::runtime_error(
        std::string("open stderr failed: errno=") +
        std::to_string(errno) +
        " (" + std::strerror(errno) + ")"
    );
  }

  pid_t pid = fork();
  if (pid == 0) {
    pid_t spid = setsid();
    if (spid == -1) {
      exit(-1);
    }
    if (chdir(step->run_path.c_str()) != 0) {
      std::cerr << "chdir failed" << std::endl;
      exit(-1);
    }
    /*char const** args = (char const**)(malloc(7*sizeof(char*)));
    args[0] = "run_task";
    std::string user_functions = script_path_ + "/campaign.conf";
    args[1] = user_functions.c_str();
    std::string envFile = run_path_ + "/" + std::to_string(step->task_id_) +
        "/.taskenv";
    args[2] = envFile.c_str();
    args[3] = std::to_string(spid).c_str();
    args[4] = std::to_string(step->rank_id_).c_str();
    args[5] = step->function_.c_str();*/

    std::vector<char*> arg_strings;
    arg_strings.push_back("run_task");
    arg_strings.push_back(strdup(std::string(script_path_ + "/campaign.conf").c_str()));
    arg_strings.push_back(strdup(std::string(run_path_ + "/" + std::to_string(step->task_id_) +
        "/.taskenv").c_str()));
    arg_strings.push_back(strdup(std::to_string(spid).c_str()));
    arg_strings.push_back(strdup(std::to_string(step->rank_id_).c_str()));
    arg_strings.push_back(strdup(step->function_.c_str()));
    std::istringstream iss(step->args_);
    std::string token;
    while (iss >> token) {
      arg_strings.push_back(strdup(token.c_str()));
    }
    arg_strings.push_back(NULL);
    std::string script = script_path_ + "/executor.sh";

    if (!RedirectOutput(outhandler, errhandler)) {
      std::cerr << "RedirectOutput failed" << std::endl;
      exit(-1);
    }

    int retval = execv(script.c_str(), arg_strings.data());

    std::cerr << strerror(errno) << std::endl;
    exit(-1);
  }
  close(errhandler);
  close(outhandler);
  step->pid_ = pid;
  return pid;
}

void Schedule::ScheduleLoop() {
  std::vector<pid_t> pids;
  std::vector<bool> cpusFree(maxCPU_, true);
  uint64_t nbCPUsFree = maxCPU_;
  lockThread_.lock();
  while((!steps_.empty()) && (threadRunning_)) {
    std::list<Schedule::Step*> toRun = SearchTaskToRun(nbCPUsFree, steps_);
    lockThread_.unlock();

    
    for(Schedule::Step* step : toRun) {
      step->cpus_ = AssignCPU(cpusFree, step->nb_cpu_);
      nbCPUsFree -= step->nb_cpu_;
      step->state_ = 1;
      Execute(step);
    }

    pid_t childPID = -1;
    int status;
    while(threadRunning_) {
      childPID = waitpid(-1, &status, WNOHANG);
      if (childPID == -1) {
        if (errno == EINTR) {
          continue;
        }
        throw std::runtime_error(
            std::string("waitpid failed in ScheduleLoop: errno=") +
            std::to_string(errno) +
            " (" + std::strerror(errno) + ")"
        );
      } else if (childPID == 0) {
        sleep(1);
      } else {
        kill(-childPID, SIGKILL);
        break;
      }
    }

    Schedule::Step* stepDone = NULL;
    for(Schedule::Step* step : toRun) {
      if (step->pid_ != childPID) {
        continue;
      }
      step->state_ = 2;
      ReleaseCPU(nbCPUsFree, cpusFree, step->cpus_);
      stepDone = step;
      break;
    }

    lockThread_.lock();
    if (stepDone != NULL) {
      toRun.remove(stepDone);
      try {
        ManageEndOfStep(stepDone);
      } catch(std::runtime_error& e) {
        threadRunning_ = false;
        lockThread_.unlock();
        printf("Exception S\n");
        throw e;
      }
    }
  }
  for (Schedule::Step* step: steps_) {
    if (step->state_ == 1) {
      // Kill still running step (to test)
      kill(step->pid_, SIGKILL);
      waitpid(step->pid_, NULL, 0);
    }
  }
  threadRunning_ = false;
  printf("Done S\n");
  lockThread_.unlock();
}

void Schedule::ManageEndOfStep(Schedule::Step* step) {
  auto itStep = std::find(steps_.begin(), steps_.end(), step);
  if (itStep != steps_.end()) {
    for (auto rit = step->dependencies_.rbegin(); rit != step->dependencies_.rend(); ++rit) {
      Schedule::Step* stepChild = *rit;
      stepChild->depend_from_.remove(step);
      if (stepChild->depend_from_.size() == 0) {
        steps_.insert(itStep, stepChild);
      }
    }
  } else {
    throw std::runtime_error("Trying to delete a non-root task: name=" +
        step->name_ + ", uuid=" + std::to_string(step->uuid_));
  }
  if (step->dependencies_.empty()) {
    bool allStepDone = true;
    for(Step* itStep = step->next_; itStep != step; itStep = itStep->next_) {
      allStepDone &= itStep->state_ == 2;
    }
    if (allStepDone) {
      // todo signal end of the flow
      std::cout << "Tasks " << step->task_id_ << " done" << std::endl;
    }
  }
  steps_.remove(step);
}