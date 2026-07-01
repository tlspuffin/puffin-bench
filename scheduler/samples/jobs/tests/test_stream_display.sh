#! /bin/bash

Init() {
  echo "=== Stream Display Test ===" 1>&2
  echo "Testing live file display (\"streams\") while a step is running"
  return 0
}

DisplayFiles() {
  local nb_iterations=${nb_iterations:-60}
  local interval=${interval:-1}
  local line_size=${line_size:-80}
  local delay_iterations=${delay_iterations:-15}

  ln -s . log

  echo "Configuration: nb_iterations=$nb_iterations, interval=${interval}s, line_size=$line_size, delay_iterations=$delay_iterations" 1>&2

  # Registered as artefacts so the files are still downloadable once the task
  # is archived (the live "streams" tabs only refresh while the step is
  # running, see html/board/logsmanager.js).
  #CreateArtefact "./growing.log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-growing"
  #CreateArtefact "./status.json" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-status"
  : > growing.log
  : > status.json

  local base_pattern=$(printf '%*s' "$line_size" '' | tr ' ' 'X')

  i=0
  while [ true ]; do
    (( ++i ))
  #for ((i = 1; i <= nb_iterations; i++)); do
    # Append-only file: the viewer should tail it smoothly (offset only grows)
    printf "[%05d] %s\n" "$i" "${base_pattern:0:$((line_size - 9))}" >> growing.log

    # File fully rewritten every iteration: exercises the offset-based reader
    # against a file whose size can shrink or move between two polls
    echo "{\"iteration\": $i, \"total\": $nb_iterations, \"percent\": $((i * 100 / nb_iterations))}" > status.json

    # File created late: exercises the "not created yet" state, then the
    # transition to a normal append once it shows up
    if ((i == delay_iterations)); then
      #CreateArtefact "./late.log" "${THEJOB_STEP_ID}/${THEJOB_STEP_ATTEMPT_ID}-late"
      echo "First line, appears at iteration $delay_iterations" > late.log
    elif ((i > delay_iterations)); then
      printf "[%05d] still alive\n" "$i" >> late.log
    fi

    for file in growing.log status.json late.log; do
      [ -f "$file" ] && [ "$(stat -c%s "$file")" -gt $((1024**3)) ] && truncate -s 0 "$file"
    done

    sleep "$interval"
  done

  echo "=== Results ===" 1>&2
  echo "Wrote $nb_iterations iterations to growing.log/status.json/late.log" 1>&2
  return 0
}

MonitorDisplayFiles() {
  local out="$1"
  shift

  echo "=== Monitoring $(date) ===" > "$out"
  for f in growing.log status.json late.log; do
    if [ -f "$f" ]; then
      echo "$f: $(wc -c < "$f") bytes" >> "$out"
    else
      echo "$f: not created yet" >> "$out"
    fi
  done
}

Summary() {
  echo "=== Test Complete ===" 1>&2
  echo "Stream display test finished successfully"
  return 0
}
