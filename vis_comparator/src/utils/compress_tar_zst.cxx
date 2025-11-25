#include "compress_tar_zst.hxx"
#include <memory.h>
#include <filesystem>
#include <stdexcept>
#include <archive.h>
#include <archive_entry.h>
#include "../utils/logs.hxx"

#define CHUNK (1 << 16) // 64 KiB buffer libarchive

ssize_t ZSTDCompress::CBWrite(struct archive* ar, void* client_data, const void* buff, size_t len) {
  (void)ar;

  ZSTDCompress* c = static_cast<ZSTDCompress*>(client_data);
  c->inbuf_.src = buff;
  c->inbuf_.size = len;
  c->inbuf_.pos = 0;
  while (c->inbuf_.pos < c->inbuf_.size) {
    c->outbuf_.pos = 0;
    size_t ret = ZSTD_seekable_compressStream(c->zc_, &c->outbuf_, &c->inbuf_);
    if (ZSTD_isError(ret)) {
      fprintf(stderr, "compressStream: %s\n", ZSTD_getErrorName(ret));
      return ARCHIVE_FATAL;
    }
    fwrite(c->outbuf_.dst, 1, c->outbuf_.pos, c->fout_);
  }
  return (ssize_t)len;
}

int ZSTDCompress::CBClose(struct archive* ar, void* client_data) {
  (void)ar;
  ZSTDCompress* c = static_cast<ZSTDCompress*>(client_data);
  size_t remaining;
  do {
    c->outbuf_.pos = 0;
    remaining = ZSTD_seekable_endStream(c->zc_, &c->outbuf_);
    if (ZSTD_isError(remaining)) {
      fprintf(stderr, "endStream: %s\n", ZSTD_getErrorName(remaining));
      return ARCHIVE_FATAL;
    }
    fwrite(c->outbuf_.dst, 1, c->outbuf_.pos, c->fout_);
  } while (remaining != 0);
  return ARCHIVE_OK;
}

ZSTDCompress::ZSTDCompress(std::string const& outFile, unsigned int maxFrameSize, int compressionLevel) 
    : outChunk_(CHUNK)
{
  zc_ = ZSTD_seekable_createCStream();
  if (!zc_) { 
    fprintf(stderr, "ZSTD_seekable_createCStream failed\n"); 
    throw std::runtime_error("");
  }

  ZSTD_seekable_initCStream(zc_, compressionLevel, /*checksumFlag*/1, maxFrameSize);

  fout_ = fopen(outFile.c_str(), "wb");
  if (!fout_) { 
    throw std::runtime_error("");
  }

  outbuf_.dst = outChunk_.data();
  outbuf_.size = CHUNK;
  outbuf_.pos = 0;
}

ZSTDCompress::~ZSTDCompress()  {
  ZSTD_seekable_freeCStream(zc_);
  fclose(fout_);
}

void CompressTARZSTD(std::string const& srcDir, std::string const& outFile, bool relativePath, unsigned int maxFrameSize, int compressionLevel) {
  struct archive* a = archive_write_new();
  archive_write_set_format_pax_restricted(a);

  ZSTDCompress zsdt(outFile, 4096, 10);

  archive_write_open(a, &zsdt, NULL, ZSTDCompress::CBWrite, ZSTDCompress::CBClose);

  struct archive* disk = archive_read_disk_new();
  archive_read_disk_set_standard_lookup(disk);
  archive_read_disk_open(disk, srcDir.c_str());

  struct archive_entry* entry;
  while (archive_read_next_header2(disk, (entry = archive_entry_new())) == ARCHIVE_OK) {
    const char* path = archive_entry_sourcepath(entry);
    archive_read_disk_descend(disk);

    if (relativePath) {
      std::string finalPath = std::filesystem::relative(path, srcDir);
      LOGE(path << " = " << finalPath);
      if (finalPath == ".") {
        continue;
      }
      archive_entry_set_pathname(entry, finalPath.c_str());
    }

    archive_write_header(a, entry);
    if (archive_entry_filetype(entry) == AE_IFREG) {
      FILE* fin = fopen(path, "rb");
      if (fin) {
        unsigned char buf[CHUNK];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), fin)) > 0)
          archive_write_data(a, buf, n);
        fclose(fin);
      }
    }
    archive_entry_free(entry);
  }

  archive_read_close(disk);
  archive_read_free(disk);
  archive_write_close(a);
  archive_write_free(a);
}

#undef CHUNK
