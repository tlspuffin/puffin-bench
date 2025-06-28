cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

include(CMakeUtils.cmake)

#set(POCO_PATH "/home/olivier/Desktop/poco/cinstall")
set(POCO_PATH "/home/olivier/Desktop/Libs/install/poco-1.14.2")
#set(RAPIDJSON_PATH "/home/olivier/Desktop/rapidjson/include")
set(RAPIDJSON_PATH "/home/olivier/Desktop/Libs/install/rapidjson-1.1.0/include")

GetLibs(Poco STATIC ${POCO_PATH} "PocoNetSSL;PocoCrypto;PocoNet;PocoUtil;PocoFoundation;PocoJSON" Pocolibs VERBOSE)
CreateExternalLib(Poco "${Pocolibs}" DEPLOYTARGET setupDLL)
target_link_libraries(Poco INTERFACE ssl crypto)

add_executable(srv src/srv.cxx src/schedule.cxx)
target_link_libraries(srv PRIVATE Poco)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH})

add_executable(srv_sec src/srv_sec.cxx src/schedule.cxx)
target_link_libraries(srv_sec PRIVATE Poco)
target_include_directories(srv_sec PRIVATE ${RAPIDJSON_PATH})