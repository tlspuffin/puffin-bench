#include "system/linux_cores.hxx"
#include <embeded/installer/binary/scheduler_binary.h>
#include <embeded/installer/binary/publisher_binary.h>
#include <embeded/installer/binary/gitrestapi_binary.h>
#include <embeded/installer/binary/viscomparator_binary.h>
#include <embeded/installer/config/scheduler_config_json.h>
#include <embeded/installer/html/board/launchers/config_js.h>
#include <embeded/installer/html/board/launchers/tlspuffin/config_js.h>
#include <embeded/installer/config/git_restapi_config_json.h>
#include <embeded/installer/config/publisher_config_json.h>
#include <embeded/installer/html/publisher/summary_config_js.h>
#include <embeded/installer/config/vis_comparator-config_json.h>
#include <embeded/installer/html/index_html.h>
#include <embeded/installer/publisher/tlspuffin/rules.h>
#include <embeded/installer/publisher/sshpuffin/rules.h>
#include <embeded/installer/files.h>
#include <embeded/installer/samples.h>
#include <embeded/installer/tools/reserveport_binary.h>
#include "../utils/logs.hxx"
#include "../utils/variables.hxx"
#include "../utils/file_compressed.hxx"
#include <iostream>
#include <filesystem>
#include <string>
#include <fstream>
#include <tuple>
#include <vector>
#include <any>
#include <unistd.h>
#include <sys/types.h>
#include <pwd.h>

bool ReadFile(std::string const& filename, std::string& content) {
  std::ifstream file(filename);
  if (!file.is_open()) {
    LOGE << "Error: unable to read " << filename << Log::Flags::End;
    return false;
  }

  file.seekg(0, std::ios::end);
  content.resize(file.tellg());
  file.seekg(0, std::ios::beg);
  file.read(&content[0], content.size());  
  return file.good();
}

bool WriteFile(std::string const& filename, std::string const& content) {
  std::ofstream file(filename);
  if (!file.is_open()) {
    return false;
  }
  file << content;
  file.close();
  std::filesystem::permissions(filename,
      std::filesystem::perms::owner_read | std::filesystem::perms::owner_write |
      std::filesystem::perms::group_read | std::filesystem::perms::group_write,
      std::filesystem::perm_options::replace);
  return file.good();
}

bool WriteBinary(std::filesystem::path const& dest, unsigned char const* begin, 
    unsigned char const* end) {
  std::ofstream ofs(dest, std::ios::binary | std::ios::trunc);
  if (!ofs.is_open()) {
    std::cerr << "Unable to write " << dest << std::endl;
    return false;
  }
  ofs.write(reinterpret_cast<char const*>(begin), end - begin);
  ofs.close();
  std::filesystem::permissions(dest,
      std::filesystem::perms::owner_all |
      std::filesystem::perms::group_read | std::filesystem::perms::group_exec,
      std::filesystem::perm_options::replace);
  return ofs.good();
}

int main(int argc, char* argv[]) {
  logs.SetLevel({1, 1, 1, 1});
  std::string nbCores;
  std::string username;
  bool override = false;
  bool overrideConfig = false;
  bool needValidate = false;
  std::filesystem::path rootPath;
  std::filesystem::path binaryPath;
  std::filesystem::path dataPath;
  std::string gitRestAPIPort = "10081";
  std::string schedulerPort = "10082";
  std::string publishPort = "10083";
  std::string visComparatorPort = "10084";

  std::unordered_map<std::string, std::any> options = {
    { "--help", std::any((void*)nullptr) },
    { "--force-files", std::any(&override) },
    { "--force-config", std::any(&overrideConfig) },
    { "--rootpath", std::any(&rootPath) },
    { "--binpath", std::any(&binaryPath) },
    { "--datapath", std::any(&dataPath) },
    { "--nb-cores", std::any(&nbCores) },
    { "--username", std::any(&username) },
    { "--port-git", std::any(&gitRestAPIPort) },
    { "--port-scheduler", std::any(&schedulerPort) },
    { "--port-publisher", std::any(&publishPort) },
    { "--port-vis", std::any(&visComparatorPort) },
  };
  for(int i=1; i<argc; ++i) {
    auto it = options.find(argv[i]);
    if (it == options.end()) {
      LOGE << "Error unknow option " << argv[i] << "\n";
      return 1;
    }
    if (it->second.type() == typeid(void*)) {
      LOGI << argv[0] << " " << 
          "--rootpath <path> || --binpath <path> --datapath <path>\n" <<
          " * optional:\n" << 
          "\t--force-files : replace all no config files\n" << 
          "\t--force-config : replace all config files\n" <<
          "\t--nb-cores <nb-cores-for scheduler-tasks>\n" <<
          "\t--username <username-for-systemctl-scheduler>\n" <<
          "\t--port-git <network-port-for-git_restapi>\n" <<
          "\t--port-scheduler <network-port-for-scheduler>\n" <<
          "\t--port-publisher <network-port-for-publisher>\n" <<
          "\t--port-vis <network-port-for-vis_comparator>\n" <<
          Log::Flags::End;
      return 0;
    } else if (it->second.type() == typeid(bool*)) {
      *(std::any_cast<bool*>(it->second)) = true;
    } else if (it->second.type() == typeid(std::string*)) {
      ++i;
      if (i >= argc) {
        LOGE << "Error missing argument for option " << argv[i-1] << "\n";
        return 1;
      }
      *(std::any_cast<std::string*>(it->second)) = argv[i];
    } else if (it->second.type() == typeid(std::filesystem::path*)) {
      ++i;
      if (i >= argc) {
        LOGE << "Error missing argument for option " << argv[i-1] << "\n";
        return 1;
      }
      *(std::any_cast<std::filesystem::path*>(it->second)) = argv[i];
    }
  }
  if (rootPath.empty() && (binaryPath.empty() || dataPath.empty())) {
    LOGE << "Error require argument (--rootpath) or (--binpath and --datapath)\n";
    return 1;
  }
  if (!rootPath.empty() && (!binaryPath.empty() && !dataPath.empty())) {
    LOGE << "Error can not mix arguments (--rootpath) and (--binpath and --datapath)\n";
    return 1;
  }

  if (username.empty()) {
    needValidate = true;
    uid_t uid = geteuid(); 
    struct passwd *pw = getpwuid(uid);
    username = pw ? pw->pw_name : "unknown";
  }
  if (nbCores.empty()) {
    needValidate = true;
    ns_System::CoresMonitor cores;
    uint64_t nbCoresInt = cores.NbCores() / 2;
    if (nbCoresInt == 0) {
      nbCoresInt = 1;
    }
    nbCores = std::to_string(nbCoresInt);
  }

  LOGI << argv[0] << " ";
  for(auto const& [key, value]: options) {
    if (value.type() == typeid(bool*)) {
      if (*(std::any_cast<bool*>(value))) {
        LOGI << key << " ";
      }
    } else if (value.type() == typeid(std::string*)) {
      std::string val = *(std::any_cast<std::string*>(value));
      if (!val.empty()) {
        LOGI << key << " " << val << " ";
      }
    } else if (value.type() == typeid(std::filesystem::path*)) {
      std::string val = *(std::any_cast<std::filesystem::path*>(value));
      if (!val.empty()) {
        LOGI << key << " " << val << " ";
      }
    }
  }
  LOGI << Log::Flags::End;

  if (!rootPath.empty()) {
    rootPath = std::filesystem::absolute(rootPath);
  }

  if (binaryPath.empty()) {
    needValidate = true;
    binaryPath = rootPath / "bin";
  } else {
    binaryPath = std::filesystem::absolute(binaryPath);
  }
  if (dataPath.empty()) {
    needValidate = true;
    dataPath = rootPath / "data";
  } else {
    dataPath = std::filesystem::absolute(dataPath);
  }

  if (needValidate) {
    std::cout << "Want to use scheduler with " << nbCores << " cores as " << username << "\n";
    std::cout << "Want to use directories:\n\tfor binaries/configs: " << binaryPath << "\n\tfor data: " << dataPath << "\n[Y/y]es or [N/n]o: ";
    std::string answer;
    std::getline(std::cin, answer);
    if ((answer != "Y") && (answer != "y")) {
      std::cout <<"Abort\n";
      return 0;
    }
  }

  std::error_code ec;
  std::filesystem::create_directories(binaryPath, ec);
  std::filesystem::create_directories(dataPath, ec);
  for (std::string p: {"cache", "exports", "html", "html", "publisher/tlspuffin", "publisher/sshpuffin", 
      "repo/.scripts", "runs", "scripts", "tools/js", "users_data/scheduler", "users_data/vis_comparator"}) {
    if (std::filesystem::create_directories(dataPath / p, ec)) {
      LOGI << "Create directories" << dataPath / p  << Log::Flags::End;
    }
    if (ec) {
      LOGE << "Error while create directories" << dataPath / p  << Log::Flags::End;
      return 1;
    }
  }

  bool updateSystemCTLSample = false;
  std::string systemCTLSample = binaryPath / "samples" / "scheduler.service";
  for(auto const& [ data, dataSize, path ] : { 
      std::tuple{ (unsigned char const*) InstallFiles, InstallFiles_len, dataPath },
      std::tuple{ (unsigned char const*) SampleFiles, SampleFiles_len, binaryPath },
  }) {
    std::vector<std::string> files = FileCompressed(data, dataSize).ExtractAll(path, override);
    for(std::string const& file : files) {
      std::string filename = path / file; 
      LOGI << "Create " << filename  << Log::Flags::End;
      updateSystemCTLSample |= filename == systemCTLSample;
    }
  }

  for(auto const& [ file, dataStart, dataEnd ] : { 
      std::tuple{ binaryPath / "scheduler", (unsigned char const*)Scheduler_Binary_Start, (unsigned char const*)Scheduler_Binary_End },
      std::tuple{ binaryPath / "publisher", (unsigned char const*)Publisher_Binary_Start, (unsigned char const*)Publisher_Binary_End },
      std::tuple{ binaryPath / "git_restapi", (unsigned char const*)GitRestAPI_Binary_Start, (unsigned char const*)GitRestAPI_Binary_End },
      std::tuple{ binaryPath / "vis_comparator", (unsigned char const*)VisComparator_Binary_Start, (unsigned char const*)VisComparator_Binary_End },
      std::tuple{ dataPath / "tools" / "reserve_port", (unsigned char const*)ReservePort_Binary, (unsigned char const*)ReservePort_Binary + ReservePort_Binary_len },
  }) {
    if (!std::filesystem::exists(file) || override) {
      if (WriteBinary(file, dataStart, dataEnd)) {
        LOGI << "Create " << file  << Log::Flags::End;
      } else {
        LOGE << "Error while create " << file  << Log::Flags::End;
        return 1;
      }
    }
  }

  std::unordered_map<std::string, std::string> variables = {
    { "ROOT_PATH", rootPath },
    { "BINARY_PATH", binaryPath },
    { "DATA_PATH", dataPath },
    { "GIT_RESTAPI_PORT", gitRestAPIPort },
    { "SCHEDULER_PORT", schedulerPort },
    { "PUBLISHER_PORT", publishPort },
    { "VIS_COMPARATOR_PORT", visComparatorPort },
    { "NB_CORES", nbCores },
    { "USERNAME", username }
  };

  for(auto const& [ file, data ] : { 
      std::tuple{ binaryPath / "config.json", (char const*)SchedulerConfig_JSON_data },
      std::tuple{ dataPath / "html" / "board" / "launchers" / "config.js", (char const*)LaunchersConfig_JS_data },
      std::tuple{ dataPath / "html" / "board" / "launchers" / "tlspuffin" / "config.js", (char const*)LaunchersTLSPuffinConfig_JS_data },
      std::tuple{ binaryPath / "git_restapi-config.json", (char const*)GitRestAPIConfig_JSON_data },
      std::tuple{ binaryPath / "publisher_config.json", (char const*)PublishConfig_JSON_data },
      std::tuple{ dataPath / "html" / "publisher" / "summary_config.js", (char const*)PublishSummaryConfig_JS_data },
      std::tuple{ dataPath / "html" / "index.html", (char const*)NavigationIndex_HTML_data },
      std::tuple{ dataPath / "publisher" / "tlspuffin" / ".rules", (char const*)PublisherTLSPuffin_RULES_data },
      std::tuple{ dataPath / "publisher" / "sshpuffin" / ".rules", (char const*)PublisherSSHPuffin_RULES_data },
      std::tuple{ binaryPath / "vis_comparator-config.json", (char const*)VisComparatorConfig_JSON_data },
  }) {
    if (!std::filesystem::exists(file) || overrideConfig) {
      std::string config = data;
      config = ResolveVariables(config, variables);
      if (WriteFile(file, config)) {
        LOGI << "Create " << file  << Log::Flags::End;
      } else {
        LOGE << "Error while create " << file  << Log::Flags::End;
        return 1;
      }
    }
  }

  if (updateSystemCTLSample) {
    std::string content;
    if (!ReadFile(systemCTLSample, content)) {
      LOGE << "Error while reading " << systemCTLSample  << Log::Flags::End;
      return 1;
    }
    content = ResolveVariables(content, variables);
    if (WriteFile(systemCTLSample, content)) {
      LOGI << "Update " << systemCTLSample  << Log::Flags::End;
    } else {
      LOGE << "Error while create " << systemCTLSample  << Log::Flags::End;
      return 1;
    }
  }

  if (chdir(binaryPath.string().c_str()) != 0) {
    LOGE << "Error while acceding " << binaryPath  << Log::Flags::End;
    return 1;
  }
  int rc = std::system((std::string("./scheduler ") + (override ? "--force-install " : "") + "--only-install").c_str());
  if (rc != 0) {
    LOGE << "Error while running scheduler files extractions" << Log::Flags::End;
  }
  rc = std::system((std::string("./git_restapi ") + (override ? "--force-install " : "") + "--only-install").c_str());
  if (rc != 0) {
    LOGE << "Error while running git_restapi files extractions" << Log::Flags::End;
  }
  rc = std::system((std::string("./vis_comparator ") + (override ? "--force-install " : "") + "--install").c_str());
  if (rc != 0) {
    LOGE << "Error while running git_restapi files extractions" << Log::Flags::End;
  }

  std::cout << "\nTo use scheduler with cgroup, there is sudo and systemctl samples in " << binaryPath / "samples" << "\n\n"
      << "Install done\n\n";

  return 0;
}