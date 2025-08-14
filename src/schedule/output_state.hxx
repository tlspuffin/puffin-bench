#pragma once

namespace ns_Schedule {

enum OutputState {
  UNKNOWN = 0,
  GOT_DATA = 1,
  END_OF_DATA = 2,
  POSSIBLE_MORE_DATA = 3,
};

};