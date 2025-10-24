#pragma once

#include "publisher_api.hxx"

namespace ns_API {

struct APIS {
  ns_API::PublishAPI publishAPI_;
  APIS(ns_Publish::Config const& configPublish) 
      : publishAPI_(configPublish) {}
};

};