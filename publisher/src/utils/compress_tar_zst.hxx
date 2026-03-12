#include <string>
#include <vector>
#include <cstdint>
#include "zstd_seekable.h"

class ZSTDCompress {
public:
  static ssize_t CBWrite(struct archive* ar, void* client_data, const void* buff, size_t len);
  static int CBClose(struct archive* ar, void* client_data);

  ZSTDCompress(std::string const& outFile, unsigned int maxFrameSize, int compressionLevel =3);
  ~ZSTDCompress();

private:
  ZSTD_seekable_CStream* zc_;
  FILE* fout_;
  std::vector<uint8_t> outChunk_;
  ZSTD_inBuffer inbuf_;
  ZSTD_outBuffer outbuf_;
};

void CompressTARZSTD(std::string const& srcDir, std::string const& outFile, bool relativePath, unsigned int maxFrameSize, int compressionLevel =3);

