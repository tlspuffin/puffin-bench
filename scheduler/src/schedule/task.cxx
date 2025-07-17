#include "task.hxx"
#include "executor/executor.hxx"

ns_Schedule::Task::~Task() {
  for(auto& it : executors_) {
    delete it.second;
  }
}

void ns_Schedule::Task::FinalClean(std::filesystem::path const& savePath) {
  for(auto executorIT : executors_) {
    executorIT.first->FinalClean(savePath, this);
  }
  for(std::filesystem::path const& path: { functions_path_, files_path_ }) {
  std::error_code ec;
    if (std::filesystem::remove_all(path, ec) == -1) {
      std::cerr << "Error while removing " << path << "\n" << 
          "\t" << ec.value() << ": " << ec.message() << std::endl;
    }
  }
}