#pragma once
#include <sstream>

#define LOGE(MSG) do {\
  std::stringstream oss;\
  oss << "/!\\ " << MSG << std::endl;\
  std::cerr << oss.str();\
} while(0)

#define LOGW(MSG) do {\
  std::stringstream oss;\
  oss << "!! " << MSG << std::endl;\
  std::cerr << oss.str();\
} while(0)

#define LOGI(MSG) do {\
  std::stringstream oss;\
  oss << "** " << MSG << std::endl;\
  std::cerr << oss.str();\
} while(0)
