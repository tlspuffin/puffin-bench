cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

GetLibs(Poco STATIC ${POCO_PATH} "PocoNetSSL;PocoCrypto;PocoNet;PocoUtil;PocoFoundation;PocoJSON" Pocolibs VERBOSE)
CreateExternalLib(Poco "${Pocolibs}" DEPLOYTARGET setupDLL)
target_link_libraries(Poco INTERFACE ssl crypto)

add_executable(srv 
    src/main.cxx src/server/server.cxx src/server/parts_handler.cxx 
    src/server/request_handler.cxx src/schedule/schedule.cxx 
    src/schedule/step.cxx src/schedule/tasksmanager.cxx src/schedule/executor/executor.cxx 
    src/schedule/executor/local.cxx src/api/schedule_api.cxx
)
target_link_libraries(srv PRIVATE Poco)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH})
