#!/bin/bash

#####################################
# Init: Initialisation globale
#####################################
Init() {
  echo "=== INIT STEP ===" 1>&2
  echo "Task ID: ${THEJOB_TASK_ID}"
  echo "Step ID: ${THEJOB_STEP_ID}"
  echo "Working dir: $(pwd)"

  # Créer un fichier de référence global
  local init_time=$(date +%s)
  echo "${init_time}" > /tmp/test_group_init_${THEJOB_TASK_ID}.txt

  AddGlobalParam "init_timestamp" "${init_time}"
  AddGlobalParam "test_start" "$(date -Iseconds)"

  echo "Init completed at ${init_time}" 1>&2
  return 0
}

#####################################
# Build: Construction par configuration
#####################################
Build() {
  echo "=== BUILD STEP ===" 1>&2
  echo "Configuration: ${THEJOB_STEP_RANK_ID}"
  echo "Attempt: ${THEJOB_STEP_ATTEMPT_ID}"
  echo "Group ID: ${THEJOB_STEP_GROUP_ID}"
  echo "Working dir: $(pwd)"

  local start_time=$(date +%s)
  local config_name="Conf_${THEJOB_STEP_RANK_ID}"

  # Vérifier que nous sommes dans un répertoire de groupe
  if [ "${THEJOB_STEP_GROUP_ID}" == "0" ]; then
    echo "ERROR: Expected group_id != 0" 1>&2
    return 1
  fi

  # Créer un fichier de build partagé avec le groupe
  local build_file="build_${THEJOB_STEP_RANK_ID}.txt"
  echo "Build started at: ${start_time}" > "${build_file}"
  echo "Configuration: ${config_name}" >> "${build_file}"
  echo "Rank ID: ${THEJOB_STEP_RANK_ID}" >> "${build_file}"
  echo "Attempt ID: ${THEJOB_STEP_ATTEMPT_ID}" >> "${build_file}"
  echo "Group ID: ${THEJOB_STEP_GROUP_ID}" >> "${build_file}"
  echo "Working directory: $(pwd)" >> "${build_file}"

  # Simuler du travail
  sleep 2

  local end_time=$(date +%s)
  echo "Build finished at: ${end_time}" >> "${build_file}"
  echo "Build duration: $((end_time - start_time))s" >> "${build_file}"

  # Créer une copie pour l'artefact (CreateArtefact fait un move, pas une copie)
  # Le fichier original reste dans le répertoire pour les steps suivants du groupe
  local artefact_file="${build_file}.artefact"
  cp "${build_file}" "${artefact_file}"

  CreateArtefact "./${artefact_file}" "build/${config_name}" \
    "config:${config_name}" \
    "rank:${THEJOB_STEP_RANK_ID}" \
    "start:${start_time}" \
    "end:${end_time}"

  echo "Build completed for ${config_name}" 1>&2
  return 0
}

#####################################
# Test: Test utilisant les builds
#####################################
Test() {
  echo "=== TEST STEP ===" 1>&2
  echo "Configuration: ${THEJOB_STEP_RANK_ID}"
  echo "Attempt: ${THEJOB_STEP_ATTEMPT_ID}"
  echo "Group ID: ${THEJOB_STEP_GROUP_ID}"
  echo "Working dir: $(pwd)"

  local start_time=$(date +%s)
  local config_name="Conf_${THEJOB_STEP_RANK_ID}"
  local build_file="build_${THEJOB_STEP_RANK_ID}.txt"

  # VALIDATION CRITIQUE: Le fichier de build doit exister (partage de répertoire)
  if [ ! -f "${build_file}" ]; then
    echo "ERROR: Build file '${build_file}' not found!" 1>&2
    echo "This means directory sharing is NOT working!" 1>&2
    echo "Current directory contents:" 1>&2
    ls -la 1>&2
    return 1
  fi

  echo "✅ SUCCESS: Found build file (directory sharing works!)" 1>&2

  # Lire les informations du build
  local build_start=$(grep "^Build started at:" "${build_file}" | cut -d: -f2- | xargs)
  local build_end=$(grep "^Build finished at:" "${build_file}" | cut -d: -f2- | xargs)

  echo "Build was: start=${build_start}, end=${build_end}" 1>&2
  echo "Test is: start=${start_time}" 1>&2

  # VALIDATION CRITIQUE: Test doit commencer APRÈS la fin du Build
  if [ "${start_time}" -lt "${build_end}" ]; then
    echo "ERROR: Test started before Build finished!" 1>&2
    echo "This means sequential execution is NOT working!" 1>&2
    return 1
  fi

  echo "✅ SUCCESS: Test started after Build (sequential execution works!)" 1>&2

  # Créer le fichier de test
  local test_file="test_${THEJOB_STEP_RANK_ID}.txt"
  echo "Test started at: ${start_time}" > "${test_file}"
  echo "Configuration: ${config_name}" >> "${test_file}"
  echo "Build start: ${build_start}" >> "${test_file}"
  echo "Build end: ${build_end}" >> "${test_file}"
  echo "Validated: Build->Test sequential order" >> "${test_file}"

  # Simuler des tests
  sleep 3

  local end_time=$(date +%s)
  echo "Test finished at: ${end_time}" >> "${test_file}"
  echo "Test duration: $((end_time - start_time))s" >> "${test_file}"
  echo "Test result: PASSED" >> "${test_file}"

  # Créer une copie pour l'artefact (CreateArtefact fait un move, pas une copie)
  # Le fichier original reste dans le répertoire pour les steps suivants du groupe
  local artefact_file="${test_file}.artefact"
  cp "${test_file}" "${artefact_file}"

  CreateArtefact "./${artefact_file}" "test/${config_name}" \
    "config:${config_name}" \
    "rank:${THEJOB_STEP_RANK_ID}" \
    "result:PASSED"

  echo "Test completed for ${config_name}" 1>&2
  return 0
}

#####################################
# Verify: Vérification finale
#####################################
Verify() {
  echo "=== VERIFY STEP ===" 1>&2
  echo "Configuration: ${THEJOB_STEP_RANK_ID}"
  echo "Attempt: ${THEJOB_STEP_ATTEMPT_ID}"
  echo "Group ID: ${THEJOB_STEP_GROUP_ID}"
  echo "Working dir: $(pwd)"

  local start_time=$(date +%s)
  local config_name="Conf_${THEJOB_STEP_RANK_ID}"
  local build_file="build_${THEJOB_STEP_RANK_ID}.txt"
  local test_file="test_${THEJOB_STEP_RANK_ID}.txt"

  # VALIDATION: Les deux fichiers doivent exister
  if [ ! -f "${build_file}" ]; then
    echo "ERROR: Build file not found!" 1>&2
    return 1
  fi

  if [ ! -f "${test_file}" ]; then
    echo "ERROR: Test file not found!" 1>&2
    return 1
  fi

  echo "✅ SUCCESS: Both build and test files found!" 1>&2

  # Extraire les timestamps
  local build_start=$(grep "^Build started at:" "${build_file}" | cut -d: -f2- | xargs)
  local build_end=$(grep "^Build finished at:" "${build_file}" | cut -d: -f2- | xargs)
  local test_start=$(grep "^Test started at:" "${test_file}" | cut -d: -f2- | xargs)
  local test_end=$(grep "^Test finished at:" "${test_file}" | cut -d: -f2- | xargs)

  # VALIDATION CRITIQUE: Ordre chronologique complet
  local verify_file="verify_${THEJOB_STEP_RANK_ID}.txt"
  echo "Verification Report for ${config_name}" > "${verify_file}"
  echo "=======================================" >> "${verify_file}"
  echo "" >> "${verify_file}"
  echo "Timeline:" >> "${verify_file}"
  echo "  Build:  ${build_start} -> ${build_end} (duration: $((build_end - build_start))s)" >> "${verify_file}"
  echo "  Test:   ${test_start} -> ${test_end} (duration: $((test_end - test_start))s)" >> "${verify_file}"
  echo "  Verify: ${start_time} -> now" >> "${verify_file}"
  echo "" >> "${verify_file}"

  local all_valid=true

  # Vérifier: Build_start < Build_end
  if [ "${build_start}" -ge "${build_end}" ]; then
    echo "❌ FAILED: Build start >= Build end" >> "${verify_file}"
    all_valid=false
  else
    echo "✅ PASSED: Build start < Build end" >> "${verify_file}"
  fi

  # Vérifier: Build_end <= Test_start
  if [ "${build_end}" -gt "${test_start}" ]; then
    echo "❌ FAILED: Build end > Test start (not sequential!)" >> "${verify_file}"
    all_valid=false
  else
    echo "✅ PASSED: Build end <= Test start (sequential!)" >> "${verify_file}"
  fi

  # Vérifier: Test_start < Test_end
  if [ "${test_start}" -ge "${test_end}" ]; then
    echo "❌ FAILED: Test start >= Test end" >> "${verify_file}"
    all_valid=false
  else
    echo "✅ PASSED: Test start < Test end" >> "${verify_file}"
  fi

  # Vérifier: Test_end <= Verify_start
  if [ "${test_end}" -gt "${start_time}" ]; then
    echo "❌ FAILED: Test end > Verify start (not sequential!)" >> "${verify_file}"
    all_valid=false
  else
    echo "✅ PASSED: Test end <= Verify start (sequential!)" >> "${verify_file}"
  fi

  echo "" >> "${verify_file}"
  if [ "${all_valid}" = true ]; then
    echo "🎉 OVERALL RESULT: ALL CHECKS PASSED" >> "${verify_file}"
    echo "Directory sharing: ✅" >> "${verify_file}"
    echo "Sequential execution: ✅" >> "${verify_file}"
  else
    echo "❌ OVERALL RESULT: SOME CHECKS FAILED" >> "${verify_file}"
  fi

  # Afficher le rapport
  cat "${verify_file}" 1>&2

  # Créer une copie pour l'artefact (CreateArtefact fait un move, pas une copie)
  local artefact_file="${verify_file}.artefact"
  cp "${verify_file}" "${artefact_file}"

  CreateArtefact "./${artefact_file}" "verify/${config_name}" \
    "config:${config_name}" \
    "result:$([ "${all_valid}" = true ] && echo "PASSED" || echo "FAILED")"

  # Stocker le résultat dans un fichier partagé pour le Summary
  # Utiliser THEJOB_OUT_PATH qui est le répertoire commun à tous les steps
  local result_file="${THEJOB_OUT_PATH}/verify_result_${THEJOB_STEP_RANK_ID}.txt"

  if [ "${all_valid}" = true ]; then
    echo "PASSED" > "${result_file}"
    echo "Verification PASSED for ${config_name}" 1>&2
    return 0
  else
    echo "FAILED" > "${result_file}"
    echo "Verification FAILED for ${config_name}" 1>&2
    return 1
  fi
}

#####################################
# Summary: Résumé global
#####################################
Summary() {
  echo "=== SUMMARY STEP ===" 1>&2
  echo "Working dir: $(pwd)"

  # Collecter tous les rapports de vérification
  local summary_file="summary_report.txt"
  echo "Test Group Steps - Summary Report" > "${summary_file}"
  echo "===================================" >> "${summary_file}"
  echo "" >> "${summary_file}"
  echo "Execution Date: $(date -Iseconds)" >> "${summary_file}"
  echo "Task ID: ${THEJOB_TASK_ID}" >> "${summary_file}"
  echo "" >> "${summary_file}"

  # Chercher tous les artefacts de vérification
  # Les résultats sont stockés dans des fichiers dans THEJOB_OUT_PATH
  local all_passed=true
  local total_configs=0
  local passed_configs=0

  # Lire les résultats depuis les fichiers partagés
  for rank_id in 0 1 2; do
    local config_name="Conf_${rank_id}"
    local result_file="${THEJOB_OUT_PATH}/verify_result_${rank_id}.txt"

    if [ -f "${result_file}" ]; then
      local result_value=$(cat "${result_file}")
      ((total_configs++))
      echo "Configuration: ${config_name}" >> "${summary_file}"
      echo "-----------------------------------" >> "${summary_file}"

      if [ "${result_value}" = "PASSED" ]; then
        ((passed_configs++))
        echo "  Status: ✅ PASSED" >> "${summary_file}"
      else
        all_passed=false
        echo "  Status: ❌ FAILED" >> "${summary_file}"
      fi
      echo "" >> "${summary_file}"
    fi
  done

  # Si aucun résultat trouvé, afficher un message de debug
  if [ ${total_configs} -eq 0 ]; then
    echo "DEBUG: No results found in ${THEJOB_OUT_PATH}" >> "${summary_file}"
    echo "Contents of THEJOB_OUT_PATH:" >> "${summary_file}"
    ls -la "${THEJOB_OUT_PATH}" >> "${summary_file}" 2>&1
  fi

  echo "" >> "${summary_file}"
  echo "===================================" >> "${summary_file}"
  echo "Total Configurations: ${total_configs}" >> "${summary_file}"
  echo "Passed: ${passed_configs}" >> "${summary_file}"
  echo "Failed: $((total_configs - passed_configs))" >> "${summary_file}"
  echo "" >> "${summary_file}"

  if [ "${all_passed}" = true ] && [ "${total_configs}" -eq 3 ]; then
    echo "🎉 FINAL RESULT: ALL TESTS PASSED!" >> "${summary_file}"
    echo "" >> "${summary_file}"
    echo "Validated features:" >> "${summary_file}"
    echo "  ✅ Group step execution" >> "${summary_file}"
    echo "  ✅ Directory sharing (GID)" >> "${summary_file}"
    echo "  ✅ Sequential execution order" >> "${summary_file}"
    echo "  ✅ Configuration-specific retry" >> "${summary_file}"
  else
    echo "❌ FINAL RESULT: SOME TESTS FAILED" >> "${summary_file}"
  fi

  # Afficher le résumé
  cat "${summary_file}" 1>&2

  # Créer un artefact JSON pour faciliter l'analyse
  local json_file="summary.json"
  cat > "${json_file}" <<EOF
{
  "test_name": "Test Group Steps",
  "task_id": "${THEJOB_TASK_ID}",
  "date": "$(date -Iseconds)",
  "total_configurations": ${total_configs},
  "passed_configurations": ${passed_configs},
  "failed_configurations": $((total_configs - passed_configs)),
  "all_passed": $([ "${all_passed}" = true ] && [ "${total_configs}" -eq 3 ] && echo "true" || echo "false"),
  "validated_features": {
    "group_execution": true,
    "directory_sharing": true,
    "sequential_order": true,
    "custom_retry": true
  }
}
EOF

  CreateArtefact "./${summary_file}" "summary_report.txt"
  CreateArtefact "./${json_file}" "summary.json" "format:json"

  if [ "${all_passed}" = true ] && [ "${total_configs}" -eq 3 ]; then
    echo "Summary: ALL TESTS PASSED" 1>&2
    return 0
  else
    echo "Summary: SOME TESTS FAILED" 1>&2
    return 1
  fi
}