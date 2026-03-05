#pragma once

#include "../../embeded/publisher/tlspuffin_history_sh.h"
#include <map>

struct InternalCmdInfos {
  std::string filename;
  char const* data;
  size_t size;
};

inline std::map<std::string, struct InternalCmdInfos> internalCMDs {
  {"tlspuffin_history", {"tlspuffin_history.sh", Publisher_Trigger_tlspuffin_history_data, Publisher_Trigger_tlspuffin_history_size}},
};
