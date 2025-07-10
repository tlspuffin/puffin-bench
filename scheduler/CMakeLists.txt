cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

GetLibs(Poco STATIC ${POCO_PATH} "PocoNetSSL;PocoCrypto;PocoNet;PocoUtil;PocoFoundation;PocoJSON" Pocolibs VERBOSE)
CreateExternalLib(Poco "${Pocolibs}" DEPLOYTARGET setupDLL)
target_link_libraries(Poco INTERFACE ssl crypto)

set(SRV_SRC 
  src/main.cxx src/config.cxx 
  src/server/config.cxx src/server/server.cxx src/server/parts_handler.cxx src/server/request_handler.cxx 
  src/schedule/config.cxx src/schedule/schedule.cxx src/schedule/step.cxx src/schedule/tasksmanager.cxx 
  src/schedule/executor/config.cxx src/schedule/executor/executor.cxx src/schedule/executor/local.cxx 
  src/api/schedule_api.cxx
  src/cache/config.cxx src/cache/cache.cxx
)

add_executable(srv ${SRV_SRC})
target_link_libraries(srv PRIVATE Poco)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH})

add_executable(srv-static ${SRV_SRC})
target_link_libraries(srv-static PRIVATE Poco)
target_include_directories(srv-static PRIVATE ${RAPIDJSON_PATH})
target_link_options(srv-static PRIVATE -static)
