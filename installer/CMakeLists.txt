cmake_minimum_required(VERSION 3.5.0)
project(scheduler)

set (CMAKE_CXX_STANDARD 17)
enable_language(ASM)

include(CMakeExternal.cmake)
include(CMakeTextEmbedding.cmake)
include(CMakeBinaryEmbedding.cmake)
include(CMakeDirectoryEmbedding.cmake)
include(CMakeBinaryEmbeddingAsm.cmake)

set(DEPS_BASE_DIR "${CMAKE_SOURCE_DIR}/third-party")

get_property(IS_MULTI_CONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(NOT CMAKE_BUILD_TYPE AND NOT IS_MULTI_CONFIG)
  set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Choose the type of build." FORCE)
  set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS "Debug" "Release" "RelWithDebInfo" "MinSizeRel")
endif()

set(IN_VERSION_C "${CMAKE_CURRENT_SOURCE_DIR}/src/version.c.in")
set(GENERATED_VERSION_C "${CMAKE_BINARY_DIR}/version.c")
if (NOT TARGET generate_version)
  add_custom_target(generate_version ALL
      COMMAND ${CMAKE_COMMAND} -DINPUT=${IN_VERSION_C} -DOUTPUT=${GENERATED_VERSION_C} -P ${CMAKE_CURRENT_SOURCE_DIR}/CMakeGenVersion.cmake
      BYPRODUCTS ${GENERATED_VERSION_C}
      VERBATIM
  )
else()
  set_source_files_properties(${GENERATED_VERSION_C} PROPERTIES GENERATED TRUE)
endif()

set(QUICKJS_CMAKE_ARGS
    "-DBUILD_SHARED_LIBS=OFF"
    "-DQJS_BUILD_CLI_STATIC=ON"
)
FetchAndCreateExternalLib(
  NAME           QuickJS
  OUTPUT_TARGET  QuickJSTN
  GIT_URL        https://github.com/quickjs-ng/quickjs.git
  GIT_TAG        v0.16.1
  CMAKE_ARGS     ${QUICKJS_CMAKE_ARGS}
  LIBTYPE        STATIC
  HEADERSAMPLE   "quickjs.h"
  REQUIREDLIBS   "qjs"
  #VERBOSE
)

if(IS_MULTI_CONFIG)
  set(QJS_CLI_BLD "${${QuickJSTN}_INSTALL_DIR}/$<CONFIG>/bin/qjs${CMAKE_EXECUTABLE_SUFFIX}")
else()
  set(QJS_CLI_BLD "${${QuickJSTN}_INSTALL_DIR}/${CMAKE_BUILD_TYPE}/bin/qjs${CMAKE_EXECUTABLE_SUFFIX}")
endif()
add_custom_command(
  OUTPUT "${CMAKE_CURRENT_SOURCE_DIR}/data/tools/qjs"
  COMMAND ${CMAKE_COMMAND} -E copy "${QJS_CLI_BLD}" "${CMAKE_CURRENT_SOURCE_DIR}/data/tools/qjs"
  DEPENDS ${QuickJSTN}
  VERBATIM
)
add_custom_target(deploy_qjs_cli ALL DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/data/tools/qjs")


FetchAndCreateExternalLib(
  NAME          zlib
  OUTPUT_TARGET zlibTN
  GIT_URL       https://github.com/madler/zlib.git
  GIT_TAG       v1.3.2
  CMAKE_ARGS    "-DZLIB_BUILD_SHARED=OFF;-DZLIB_BUILD_TESTING=OFF"
  LIBTYPE       STATIC
  HEADERSAMPLE  "zlib.h"
  REQUIREDLIBS  "z"
  #VERBOSE
)

set(LIBARCHIVE_CMAKE_ARGS
    "-DBUILD_SHARED_LIBS=OFF"
    "-DBUILD_TESTING=OFF"
    "-DENABLE_BZip2=OFF"
    "-DENABLE_LIBXML2=OFF"
    "-DENABLE_LZ4=OFF"
    "-DENABLE_LZMA=OFF"
    "-DENABLE_OPENSSL=OFF"
    "-DENABLE_TEST=OFF"
    "-DENABLE_ZSTD=OFF"
    "-DENABLE_ACL=OFF"
)
AppendCMakeArgs(LIBARCHIVE_CMAKE_ARGS "ZLIB_INCLUDE_DIR;ZLIB_LIBRARY_RELEASE;ZLIB_LIBRARY_DEBUG" ${zlibTN}::z)
FetchAndCreateExternalLib(
  NAME           LibArchive
  OUTPUT_TARGET  LibArchiveTN
  GIT_URL        https://github.com/libarchive/libarchive.git
  GIT_TAG        v3.8.7
  CMAKE_ARGS     ${LIBARCHIVE_CMAKE_ARGS}
  LIBTYPE        STATIC
  HEADERSAMPLE   "archive.h"
  REQUIREDLIBS   "archive"
  LINK_LIBRARIES "${zlibTN}"
  #VERBOSE
)

add_executable(reserve_port src/reserve_port.c)
add_executable(reserve_port-static src/reserve_port.c)
target_link_options(reserve_port-static PRIVATE -static)
EmbedBinaryTargets(ReservePort_Binary PATH "${CMAKE_SOURCE_DIR}/embeded/installer/tools/" TARGETS reserve_port-static reserve_port)


EmbedBinaryTargetAsm(scheduler "${CMAKE_SOURCE_DIR}/embeded/installer/binary/scheduler_blob.s" Scheduler_Binary)
EmbedBinaryTargetAsm(scheduler-static "${CMAKE_SOURCE_DIR}/embeded/installer/binary/scheduler_blob-static.s" Scheduler_Binary)
EmbedBinaryTargetAsm(git_restapi "${CMAKE_SOURCE_DIR}/embeded/installer/binary/git_restapi_blob.s" GitRestAPI_Binary)
EmbedBinaryTargetAsm(git_restapi-static "${CMAKE_SOURCE_DIR}/embeded/installer/binary/git_restapi_blob-static.s" GitRestAPI_Binary)
EmbedBinaryTargetAsm(publisher "${CMAKE_SOURCE_DIR}/embeded/installer/binary/publisher_blob.s" Publisher_Binary)
EmbedBinaryTargetAsm(publisher-static "${CMAKE_SOURCE_DIR}/embeded/installer/binary/publisher_blob-static.s" Publisher_Binary)
EmbedBinaryTargetAsm(vis_comparator "${CMAKE_SOURCE_DIR}/embeded/installer/binary/vis_comparator_blob.s" VisComparator_Binary)
EmbedBinaryTargetAsm(vis_comparator-static "${CMAKE_SOURCE_DIR}/embeded/installer/binary/vis_comparator_blob-static.s" VisComparator_Binary)

EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/config/config.json" "${CMAKE_SOURCE_DIR}/embeded/installer/config/scheduler_config_json.c" SchedulerConfig_JSON)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/data/html/board/launchers/config.js" "${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/config_js.c" LaunchersConfig_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/data/html/board/launchers/tlspuffin/config.js" "${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/tlspuffin/config_js.c" LaunchersTLSPuffinConfig_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/config/git_restapi-config.json" "${CMAKE_SOURCE_DIR}/embeded/installer/config/git_restapi_config_json.c" GitRestAPIConfig_JSON)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/config/publisher_config.json" "${CMAKE_SOURCE_DIR}/embeded/installer/config/publisher_config_json.c" PublishConfig_JSON)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/data/html/publisher/summary_config.js" "${CMAKE_SOURCE_DIR}/embeded/installer/html/publisher/summary_config_js.c" PublishSummaryConfig_JS)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/config/vis_comparator-config.json" "${CMAKE_SOURCE_DIR}/embeded/installer/config/vis_comparator-config_json.c" VisComparatorConfig_JSON)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/data/html/index.html" "${CMAKE_SOURCE_DIR}/embeded/installer/html/index_html.c" NavigationIndex_HTML)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/data/publisher/tlspuffin/.rules" "${CMAKE_SOURCE_DIR}/embeded/installer/publisher/tlspuffin/rules.c" PublisherTLSPuffin_RULES)
EmbedTextFileScript("${CMAKE_CURRENT_SOURCE_DIR}/data/publisher/sshpuffin/.rules" "${CMAKE_SOURCE_DIR}/embeded/installer/publisher/sshpuffin/rules.c" PublisherSSHPuffin_RULES)

set(TLSPUFFIN_SCRIPTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/scripts")
set(TLSPUFFIN_JOBSCRIPTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/data/html/jobsscripts/tlspuffin")
find_program(BASH_EXECUTABLE bash REQUIRED)
add_custom_command(
  OUTPUT "${TLSPUFFIN_JOBSCRIPTS_DIR}/PR_perf_full.sh" "${TLSPUFFIN_JOBSCRIPTS_DIR}/PR_vulnerabilities_full.sh"
  COMMAND "${BASH_EXECUTABLE}" "${TLSPUFFIN_SCRIPTS_DIR}/build.sh"
  COMMAND ${CMAKE_COMMAND} -E copy "${TLSPUFFIN_SCRIPTS_DIR}/PR_perf_full.sh" "${TLSPUFFIN_JOBSCRIPTS_DIR}/PR_perf_full.sh"
  COMMAND ${CMAKE_COMMAND} -E copy "${TLSPUFFIN_SCRIPTS_DIR}/PR_vulnerabilities_full.sh" "${TLSPUFFIN_JOBSCRIPTS_DIR}/PR_vulnerabilities_full.sh"
  DEPENDS "${TLSPUFFIN_SCRIPTS_DIR}/build.sh" "${TLSPUFFIN_SCRIPTS_DIR}/PR_common.sh" "${TLSPUFFIN_SCRIPTS_DIR}/PR_perf.sh" "${TLSPUFFIN_SCRIPTS_DIR}/PR_vulnerabilities.sh"
  COMMENT "Running build.sh to generate PR_perf_full.sh / PR_vulnerabilities_full.sh"
  VERBATIM
)
add_custom_target(generate_tlspuffin_scripts ALL
  DEPENDS "${TLSPUFFIN_JOBSCRIPTS_DIR}/PR_perf_full.sh" "${TLSPUFFIN_JOBSCRIPTS_DIR}/PR_vulnerabilities_full.sh"
)

EmbedDirectory("${CMAKE_CURRENT_SOURCE_DIR}/data" "${CMAKE_SOURCE_DIR}/embeded/installer/files.c" InstallFiles
  FILES html/board/launchers/tlspuffin/joblauncher.css html/board/launchers/tlspuffin/joblauncher.js html/board/launchers/tlspuffin/jobsconfig.json
  html/jobsscripts/tlspuffin/PR_campaign.json html/jobsscripts/tlspuffin/PR_perf_cargo.json html/jobsscripts/tlspuffin/PR_perf_full.sh 
  html/jobsscripts/tlspuffin/PR_vulnerabilities_full.sh html/jobsscripts/tlspuffin/PR_vulnerabilities-groupA_cargo.json html/jobsscripts/tlspuffin/PR_vulnerabilities-groupB_cargo.json
  html/jobsscripts/tlspuffin/shell.nix html/jobsscripts/tlspuffin/wolfssl_put.c.patch tools/qjs 
  tools/js/utils.js tools/js/perf_experiment_end.js tools/js/vuln_experiment_end.js tools/js/perf_summary_run.js tools/js/vuln_summary_run.js
  tools/js/get_last_stats_time.js
  html/publisher/summary.html html/publisher/summary.css html/publisher/summary.js
  html/publisher/summary_render.js html/publisher/summary_data.js html/publisher/summary_metrics.js html/publisher/summary_metricscampaign.js 
  html/publisher/summary_graph.js html/publisher/summary_managegraphs.js 
  html/publisher/summary_graphoverview.js html/publisher/summary_graphoverview.css 
  html/publisher/summary_graphmetrics.js html/publisher/summary_graphmetrics.css
  html/publisher/summary_graphcompare.js
  html/third-party/plotly/plotly-3.3.0.min.js
  html/index.css
)
EmbedDirectory("${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_SOURCE_DIR}/embeded/installer/samples.c" SampleFiles 
  FILES samples/scheduler.service samples/scheduler.sudoers
)

add_library(installer.lib STATIC 
    src/utils/logs.cxx src/utils/logs.hxx src/utils/variables.cxx src/utils/variables.hxx 
    src/utils/file_compressed.cxx src/utils/file_compressed.hxx
    src/installer/system/linux_cores.cxx src/installer/system/linux_cores.hxx
    "${CMAKE_SOURCE_DIR}/embeded/installer/files.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/samples.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/config/scheduler_config_json.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/config_js.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/tlspuffin/config_js.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/config/git_restapi_config_json.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/config/publisher_config_json.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/html/publisher/summary_config_js.c" 
    "${CMAKE_SOURCE_DIR}/embeded/installer/config/vis_comparator-config_json.c" 
    "${CMAKE_SOURCE_DIR}/embeded/installer/html/index_html.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/publisher/tlspuffin/rules.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/publisher/sshpuffin/rules.c"
    "${CMAKE_SOURCE_DIR}/embeded/installer/tools/reserveport_binary.h"
    ${GENERATED_VERSION_C}
)
target_link_libraries(installer.lib PUBLIC ${LibArchiveTN})
target_include_directories(installer.lib PRIVATE ${CMAKE_SOURCE_DIR})
add_dependencies(installer.lib generate_version)

add_executable(installer src/installer/main.cxx 
    ${CMAKE_SOURCE_DIR}/embeded/installer/files.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/samples.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/scheduler_config_json.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/config_js.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/tlspuffin/config_js.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/git_restapi_config_json.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/publisher_config_json.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/publisher/summary_config_js.h 
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/vis_comparator-config_json.h 
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/index_html.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/publisher/tlspuffin/rules.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/publisher/sshpuffin/rules.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/scheduler_blob.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/git_restapi_blob.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/publisher_blob.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/vis_comparator_blob.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/tools/reserve_port.c
)
target_link_libraries(installer PRIVATE installer.lib)
target_include_directories(installer PRIVATE ${CMAKE_SOURCE_DIR})

add_executable(installer-static src/installer/main.cxx 
    ${CMAKE_SOURCE_DIR}/embeded/installer/files.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/samples.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/scheduler_config_json.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/config_js.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/board/launchers/tlspuffin/config_js.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/git_restapi_config_json.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/publisher_config_json.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/publisher/summary_config_js.h 
    ${CMAKE_SOURCE_DIR}/embeded/installer/config/vis_comparator-config_json.h 
    ${CMAKE_SOURCE_DIR}/embeded/installer/html/index_html.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/publisher/tlspuffin/rules.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/publisher/sshpuffin/rules.h
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/scheduler_blob-static.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/git_restapi_blob-static.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/publisher_blob-static.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/binary/vis_comparator_blob-static.s
    ${CMAKE_SOURCE_DIR}/embeded/installer/tools/reserve_port-static.c
)
target_link_libraries(installer-static PRIVATE installer.lib)
target_include_directories(installer-static PRIVATE ${CMAKE_SOURCE_DIR})
target_link_options(installer-static PRIVATE -static-libgcc -static-libstdc++)
