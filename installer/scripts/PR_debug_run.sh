#! /bin/bash

SERVER_PATH='/home/olivier/Desktop/restsrv';

BASE_PATH="$( dirname $( realpath "${BASH_SOURCE[0]}" ) )";
LAUNCH_PATH="$( pwd )";

THEJOB_CACHE_PORT=8080
THEJOB_OUT_PATH="$( mktemp -d)";
#THEJOB_OUT_PATH='/tmp/tmp.4ry7TzIQxS';
THEJOB_STEP_ID=0;
THEJOB_STEP_ATTEMPT_ID=0;
THEJOB_NB_CORES=3;
THEJOB_TOOLS_PATH="${SERVER_PATH}/tools";
THEJOB_USER_FILES_PATH="${SERVER_PATH}/samples";
THEJOB_FUNCTIONS_PATH="${BASE_PATH}/PR_common.sh";

COMMIT_ID='2d000bfe0'
experiment="WolfSSL";
features="'asan,wolfssl540'";
vendor="wolfssl:wolfssl580-asan"

THEJOB_SH_CONFIG_FILE='/dev/null';
THEJOB_ARTEFACTS_FILE="${LAUNCH_PATH}/artefacts.data";

echo "BASE_PATH= ${BASE_PATH}";
echo "THEJOB_OUT_PATH= ${THEJOB_OUT_PATH}";
echo "COMMIT_ID= ${COMMIT_ID}";

source "${BASE_PATH}/PR_common.sh"
source "${BASE_PATH}/PR_perf.sh"
source "${SERVER_PATH}/scripts/functions.sh"

pushd .
Init
popd
pushd .
Build
popd
rm -rf repo
pushd .
THEJOB_MONITOR_PARAMETERS_PATH="'MonitorExperiment' 60 0 10 ${LAUNCH_PATH}/monitor.out"
Experiment
StopMonitor
popd
#pushd .
#Clean
#popd
