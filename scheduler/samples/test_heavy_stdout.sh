#! /bin/bash

Init() {
  echo "=== Heavy Stdout Test ===" 1>&2
  echo "Testing stdout buffering and throughput"
  return 0
}

HeavyOutput() {
  local nb_lines=${nb_lines:-10000}
  local line_size=${line_size:-80}
  local with_stderr=${with_stderr:-false}

  echo "Configuration: nb_lines=$nb_lines, line_size=$line_size, with_stderr=$with_stderr" 1>&2
  echo "Starting heavy output generation..." 1>&2

  CreateArtefact "./stats.txt" "${THEJOB_STEP_ID}/${THEJOB_STEP_RANK_ID}-stats"

  local start_time=$(date +%s.%N)
  local total_bytes=0

  # Génération d'une ligne de base de la taille demandée
  local base_pattern=$(printf '%*s' "$line_size" '' | tr ' ' 'X')

  for i in $(seq 1 $nb_lines); do
    # Output sur stdout
    printf "[%08d] %s\n" "$i" "${base_pattern:0:$((line_size - 12))}"
    total_bytes=$((total_bytes + line_size + 1))

    # Optionnel: output sur stderr aussi
    if [ "$with_stderr" = "true" ] && [ $((i % 1000)) -eq 0 ]; then
      echo "Progress: $i / $nb_lines lines" 1>&2
    fi

    # Mise à jour du fichier de stats pour le monitoring
    if [ $((i % 5000)) -eq 0 ]; then
      local current_time=$(date +%s.%N)
      local elapsed=$(echo "$current_time - $start_time" | bc)
      echo "$i $total_bytes $elapsed" > stats.txt
    fi
  done

  local end_time=$(date +%s.%N)
  local total_time=$(echo "$end_time - $start_time" | bc)
  local throughput=$(echo "scale=2; $total_bytes / $total_time / 1024 / 1024" | bc)

  echo "$nb_lines $total_bytes $total_time $throughput" > stats.txt

  echo "=== Results ===" 1>&2
  echo "Total lines: $nb_lines" 1>&2
  echo "Total bytes: $total_bytes" 1>&2
  echo "Total time: ${total_time}s" 1>&2
  echo "Throughput: ${throughput} MB/s" 1>&2

  return 0
}

MonitorHeavyOutput() {
  local out="$1"
  shift

  echo "=== Monitoring $(date) ===" > "$out"

  if [ -f "stats.txt" ]; then
    local stats=$(cat stats.txt)
    local lines=$(echo "$stats" | awk '{print $1}')
    local bytes=$(echo "$stats" | awk '{print $2}')
    local elapsed=$(echo "$stats" | awk '{print $3}')

    echo "Lines written: $lines" >> "$out"
    echo "Bytes written: $bytes" >> "$out"
    echo "Elapsed time: ${elapsed}s" >> "$out"

    if [ -n "$elapsed" ] && [ "$elapsed" != "0" ]; then
      local rate=$(echo "scale=2; $lines / $elapsed" | bc 2>/dev/null || echo "N/A")
      echo "Rate: $rate lines/s" >> "$out"
    fi
  else
    echo "No stats yet..." >> "$out"
  fi
}

Summary() {
  echo "=== Test Complete ===" 1>&2
  echo "Heavy stdout test finished successfully"
  return 0
}
