# Fonction principale - simule un travail long
SimulationLongue() {
  echo "Début simulation..." 1>&2;
  echo "Début simulation..."

  StartMonitor
  for i in {1..100}; do
    echo "Progress: $i%" > progress.txt
    echo "$(date): Iteration $i/100"
    sleep 2  # Simule du travail

    # Créer des fichiers de résultats
    echo "Result $i: $(( $RANDOM % 1000 ))" >> results.txt
  done

  echo "Simulation terminée !"
}

# Fonction de monitoring
MonitorSimulation() {
  local output_file="$1"

  echo "=== Monitoring $(date) ===" > "$output_file"

  # Vérifier la progression
  if [ -f "progress.txt" ]; then
    echo "Progression actuelle: $(cat progress.txt)" >> "$output_file"
  else
    echo "❌ Pas encore de progression détectée" >> "$output_file"
  fi

  # Compter les résultats
  if [ -f "results.txt" ]; then
    local count=$(wc -l < results.txt)
    echo "📊 Nombre de résultats: $count" >> "$output_file"
  fi

  # Vérifier l'usage mémoire du processus
  local memory=$(ps aux | grep "SimulationLongue" | grep -v grep | awk '{print $4}' || echo "0")
  echo "💾 Usage mémoire: ${memory}%" >> "$output_file"

  # Indicateur de santé
  if [ -f "progress.txt" ]; then
    local progress=$(cat progress.txt | cut -d: -f2 | cut -d% -f1)
    if [ "$progress" -gt 50 ]; then
      echo "✅ Status: Healthy (>50%)" >> "$output_file"
    else
      echo "⏳ Status: In Progress" >> "$output_file"
    fi
  fi
}

#🔥 Job Test "Problématique" pour Timeout
# Fonction qui va traîner pour tester le timeout
MonitorLent() {
  local output_file="$1"

  echo "Début monitoring lent..." > "$output_file"
  sleep 45  # Plus long que les 30s de timeout
  echo "Fin monitoring (ne devrait jamais arriver)" >> "$output_file"
}

#📊 Job Test "Échec" pour Tester la Gestion d'Erreur
MonitorQuiEchoue() {
  local output_file="$1"

  echo "Vérification critique..." > "$output_file"

  # Simuler une condition d'échec
  if [ ! -f "fichier_obligatoire.txt" ]; then
    echo "❌ ERREUR: Fichier obligatoire manquant !" >> "$output_file"
    rm "$output_file"  # Supprimer le fichier = échec
    exit 1
  fi

  echo "✅ Tout va bien" >> "$output_file"
}