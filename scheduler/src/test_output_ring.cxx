#include "scheduler/schedule/executor/output_ring.hxx"
#include "utils/file.hxx"
#include <iostream>
#include <cstring>

int failures = 0;

void Check(std::string const& label, bool cond) {
  std::cerr << (cond ? "OK   " : "FAIL ") << label << '\n';
  if (!cond) ++failures;
}

int main() {
  // Small ring so a handful of writes is enough to force it to wrap.
  ns_Executor::MemoryRing ring{"", 16};

  // Write past maxSize_ to switch the ring into full_ mode (wrapped at least once).
  for (char c = 'A'; c <= 'Z'; ++c) {
    ring.Write(reinterpret_cast<uint8_t const*>(&c), 1);
  }
  // virtualSize_ == 26, maxSize_ == 16 -> virtual window == [10, 26) == "KLMNOPQRSTUVWXYZ"

  // 1) Partial read inside the window: used to fail because Read() always
  //    overwrote data.startOffset with the window start instead of the
  //    actual requested offset.
  {
    FileExtractedText data;
    data.requestReadOffset = 15;
    data.requestReadSize = 5;
    ring.Read(data);
    Check("partial_content", data.buffer == "PQRST");
    Check("partial_start_offset", data.startOffset == 15);
  }

  // 2) Negative offset ("tail" of the last 4 bytes): used to fail because
  //    the signed/unsigned comparison rejected any negative offset outright.
  {
    FileExtractedText data;
    data.requestReadOffset = -4;
    data.requestReadSize = 4;
    ring.Read(data);
    Check("tail_content", data.buffer == "WXYZ");
    Check("tail_start_offset", data.startOffset == 22);
  }

  // 3) Requested range starts before the window but overlaps it (start
  //    partially evicted): must clamp to the window start rather than read
  //    stale/out-of-bounds data.
  {
    FileExtractedText data;
    data.requestReadOffset = 5;
    data.requestReadSize = 10;
    ring.Read(data);
    Check("evicted_clamped_content", data.buffer == "KLMNO");
    Check("evicted_clamped_start_offset", data.startOffset == 10);
  }

  // 4) Requested range entirely before the window (fully evicted data):
  //    must return an empty read, not clamp into the window.
  {
    FileExtractedText data;
    data.requestReadOffset = 0;
    data.requestReadSize = 5;
    ring.Read(data);
    Check("fully_evicted_empty", data.buffer.empty());
  }

  std::cerr << (failures == 0 ? "ALL CHECKS PASSED\n" : "SOME CHECKS FAILED\n");
  return failures == 0 ? 0 : 1;
}
