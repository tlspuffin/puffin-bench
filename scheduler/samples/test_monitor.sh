#! /bin/bash

Step1() {
  echo "Step1 running..." 1>&2;
  echo "Step1 running..."
  sleep 30
  echo "Step1 done !" 1>&2;
  echo "Step1 done !"
}

Step2() {
  echo "Pause..." 1>&2;
  echo "Pause..."
  CreateArtefact "./the_end.txt" "${THEJOB_STEP_ID}/${THEJOB_ATTEMPT_ID}-the_end"
  sleep 60
  date > ./the_end.txt
  echo "Pause done !" 1>&2;
  echo "Pause done !"
}

Step3() {
  echo "Step3 running..." 1>&2;
  echo "Step3 running..."

  CreateArtefact "./progress.txt" "${THEJOB_STEP_ID}/${THEJOB_ATTEMPT_ID}-README.md" "step:${THEJOB_STEP_ID}" "features:${features}"

  StartMonitor 1 2 3
  #while true ; do
    for i in {1..100}; do
      echo "Progress: $i%" > progress.txt
      echo "Iteration $i/100"
      sleep 1  # Simule du travail
      echo "Result $i: $(( $RANDOM % 1000 ))" >> results.txt
    done
  #done

  echo "Done" >> results.txt
  echo "Step3 done !" 1>&2;
  echo "Step3 done !"
}

MonitorStep3() {
  local out="$1"
  shift

  echo "=== Monitoring $(date) $2 ===" > "$out"

  if [ -f "progress.txt" ]; then
    echo "Progression actuelle: $(cat progress.txt)" >> "$out"
  else
    echo "❌ Pas encore de progression détectée" >> "$out"
  fi

  if [ -f "results.txt" ]; then
    local count=$(wc -l < results.txt)
    echo "📊 Nombre de résultats: $count" >> "$out"
  fi

  # Vérifier l'usage mémoire du processus
  local memory=$(ps aux | grep "SimulationLongue" | grep -v grep | awk '{print $4}' || echo "0")
  echo "💾 Usage mémoire: ${memory}%" >> "$out"

  # Indicateur de santé
  if [ -f "progress.txt" ]; then
    local progress=$(cat progress.txt | cut -d: -f2 | cut -d% -f1)
    if [ "$progress" -gt 50 ]; then
      echo "✅ Status: Healthy (>50%)" >> "$out"
    else
      echo "⏳ Status: In Progress" >> "$out"
    fi
  fi
}
