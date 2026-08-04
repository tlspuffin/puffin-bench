#include "compress_tar_zst.hxx"
#include "logs.hxx"
#include <memory.h>
#include <filesystem>
#include <stdexcept>
#include <archive.h>
#include <archive_entry.h>


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
      LOGE << "compressStream: " << ZSTD_getErrorName(ret) << Log::Flags::End;
      return ARCHIVE_FATAL;
    }
    if (fwrite(c->outbuf_.dst, 1, c->outbuf_.pos, c->fout_) != c->outbuf_.pos) {
      return ARCHIVE_FATAL;
    }
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
      LOGE << "endStream: " << ZSTD_getErrorName(remaining) << Log::Flags::End;
      return ARCHIVE_FATAL;
    }
    if (fwrite(c->outbuf_.dst, 1, c->outbuf_.pos, c->fout_) != c->outbuf_.pos) {
      return ARCHIVE_FATAL;
    }
  } while (remaining != 0);
  return ARCHIVE_OK;
}

ZSTDCompress::ZSTDCompress(std::string const& outFile, unsigned int maxFrameSize, int compressionLevel) 
    : zc_(nullptr), fout_(nullptr), outChunk_(CHUNK)
{
  zc_ = ZSTD_seekable_createCStream();
  if (!zc_) { 
    fprintf(stderr, "ZSTD_seekable_createCStream failed\n"); 
    throw std::runtime_error("ZSTD_seekable_createCStream failed");
  }

  ZSTD_seekable_initCStream(zc_, compressionLevel, /*checksumFlag*/1, maxFrameSize);

  fout_ = fopen(outFile.c_str(), "wb");
  if (!fout_) {
    ZSTD_seekable_freeCStream(zc_);
    zc_ = nullptr;
    throw std::runtime_error("ZSTDCompress unable to create " + outFile);
  }

  outbuf_.dst = outChunk_.data();
  outbuf_.size = CHUNK;
  outbuf_.pos = 0;
}

ZSTDCompress::~ZSTDCompress()  {
  Close();
}

bool ZSTDCompress::Close() {
  bool success = true;
  if (fout_ != nullptr) {
    if (fclose(fout_) != 0) {
      LOGE << "fclose failed on the output stream" << Log::Flags::End;
      success = false;
    }
    fout_ = nullptr;
  }
  if (zc_ != nullptr) {
    ZSTD_seekable_freeCStream(zc_);
    zc_ = nullptr;
  }
  return success;
}

bool CompressTARZSTD(std::string const& srcDir, std::string const& outFile, bool relativePath, unsigned int maxFrameSize, int compressionLevel) {
  std::string tmpOutFile = outFile + ".tmp";
  struct archive* archive = nullptr;
  struct archive* disk = nullptr;
  struct archive_entry* entry = nullptr;
  try {
    archive = archive_write_new();
    archive_write_set_format_pax_restricted(archive);

    ZSTDCompress zsdt(tmpOutFile, maxFrameSize, compressionLevel);

    archive_write_open(archive, &zsdt, NULL, ZSTDCompress::CBWrite, ZSTDCompress::CBClose);

    disk = archive_read_disk_new();
    archive_read_disk_set_standard_lookup(disk);
    archive_read_disk_open(disk, srcDir.c_str());

    while (archive_read_next_header2(disk, (entry = archive_entry_new())) == ARCHIVE_OK) {
      const char* path = archive_entry_sourcepath(entry);
      archive_read_disk_descend(disk);

      if (relativePath) {
        std::string finalPath = std::filesystem::relative(path, srcDir);
        if (finalPath == ".") {
          archive_entry_free(entry);
          entry = nullptr;
          continue;
        }
        archive_entry_set_pathname(entry, finalPath.c_str());
      }

      archive_write_header(archive, entry);
      if (archive_entry_filetype(entry) == AE_IFREG) {
        FILE* fin = fopen(path, "rb");
        if (fin) {
          unsigned char buf[CHUNK];
          size_t n;
          while ((n = fread(buf, 1, sizeof(buf), fin)) > 0) {
            archive_write_data(archive, buf, n);
          }
          fclose(fin);
        }
      }
      archive_entry_free(entry);
      entry = nullptr;
    }

    archive_read_close(disk);
    archive_read_free(disk);
    disk = nullptr;
    int archiveFinalStatus = archive_write_close(archive);
    archive_write_free(archive);
    archive = nullptr;
    if (archiveFinalStatus != ARCHIVE_OK) {
      throw std::runtime_error("archive_write_close failed for " + tmpOutFile);
    }

    if (!zsdt.Close()) {
      throw std::runtime_error("Unable to flush " + tmpOutFile);
    }

    std::filesystem::rename(tmpOutFile, outFile);
    return true;
  } catch(std::exception const& e) {
    if (entry != nullptr) {
      archive_entry_free(entry);
      entry = nullptr;
    }
    if (disk != nullptr) {
      archive_read_close(disk);
      archive_read_free(disk);
      disk = nullptr;
    }
    if (archive != nullptr) {
      archive_write_close(archive);
      archive_write_free(archive);
      archive = nullptr;
    }

    std::error_code ec;
    std::filesystem::remove(tmpOutFile, ec);
    if (ec) {
      LOGE << "Problem with " << tmpOutFile << ": " << ec.message() << Log::Flags::End;
    }
    throw;
  }
  return false;
}

#undef CHUNK
