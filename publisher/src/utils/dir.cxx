#include "dir.hxx"

bool DeleteFilesWithPrefix(std::filesystem::path files) {
  std::filesystem::path const directory = files.parent_path();
  std::string const prefix = files.filename();

  std::error_code ec;

  if ((!std::filesystem::exists(directory, ec)) || 
      (!std::filesystem::is_directory(directory, ec))) {
    LOGW << "Error, unable to find directory: " << directory << Log::Flags::End;
    return false;
  }

  for (std::filesystem::directory_iterator it(directory, ec), end{}; 
      it != end; it.increment(ec)) {
    if (ec) {
      LOGW << "Error while trying to read directory: " << directory << 
          " : " << ec.message() << Log::Flags::End;
      return false;
    }

    auto const& entry = *it;
    if (!entry.is_regular_file(ec)) {
      if (ec) {
        LOGW << "Error unable to query: " << entry.path() << 
            " : " << ec.message() << Log::Flags::End;
      }
      continue;
    }
    const std::string filename = entry.path().filename().string();
    if (filename.rfind(prefix, 0) == 0) {
      //LOGE << "Delete " << entry.path() << Log::Flags::End;
      std::filesystem::remove(entry.path(), ec);
      if (ec) {
        LOGW << "Error unable to delete: " << entry.path() << 
            " : " << ec.message() << Log::Flags::End;
      }
    }
  }
  return true;
}
