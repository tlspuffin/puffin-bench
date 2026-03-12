#! /bin/bash
output="$1"
[ -z "${output}" ] && {
  echo "Missing output argument";
  exit 1;
}
shift;

commit_folder=$1;
[ -z "${commit_folder}" ] && {
  echo "Missing commit folder argument";
  exit 1;
}
[ ! -d "${commit_folder}" ] || [ ! -r "${commit_folder}" ] && { 
  echo "Directory ${commit_folder} is not readable"; 
  exit 1; 
}
shift

remove_repo=0;
repo_directory=$1;
if [ -z "${repo_directory}" ]; then
  repo_directory="$(mktemp -d)"
  remove_repo=1;
else 
  [ -d "${repo_directory}" ] || { echo "${repo_directory} is not a directory"; exit 1; }
  [ -r "${repo_directory}" ] || { echo "${repo_directory} is not readable"; exit 1; }
  [ ! -z "$(ls -A "${repo_directory}")" ] && { 
    git -C "${repo_directory}" rev-parse --git-dir >/dev/null 2>&1 || { echo "${repo_directory} is not a git folder"; exit 1; }
  }
fi
shift;

info="$(mktemp)"
infoMain="$(mktemp)"
git -C "${repo_directory}" fetch 2>/dev/null || git clone --filter=blob:none https://github.com/tlspuffin/tlspuffin.git "${repo_directory}"
git -C "${repo_directory}" checkout dev
git -C "${repo_directory}" log dev --first-parent --oneline --pretty=format:"%H§%ad§%s" --date=short 0b44eed3b..dev | sed 's/^\(.........\)[^§]*/\1/' | sed 's/"/\\"/g'  | awk 'BEGIN{FS="§";PREV=""} {printf("  {\"id\":\"%s\",\"date\":\"%s\",\"comment\":\"%s\", \"branch\":\"dev\"},\n", $1, $2, $3);}' > "${info}"
git -C "${repo_directory}" log main --first-parent --oneline --pretty=format:"%H§%ad§%s" --date=short 3bc37034a^...0b44eed3b | sed 's/^\(.........\)[^§]*/\1/' | sed 's/"/\\"/g'  | awk 'BEGIN{FS="§"} {line=sprintf("  {\"id\":\"%s\",\"date\":\"%s\",\"comment\":\"%s\", \"branch\":\"main\"}", $1,$2,$3); if(NR>1) printf(",\n"); printf("%s", line)}' > "${infoMain}"
echo '{"commits": [' > "${output}.tmp"
cat "${info}" >> "${output}.tmp"
cat "${infoMain}" >> "${output}.tmp"
echo -e '],\n "standalone": []}' >> "${output}.tmp"
rm "${info}" "${infoMain}"
mv "${output}.tmp" "${output}"

tmp_json="$(mktemp)"
tmp="$(mktemp)"
cp "${output}" "${tmp_json}"
if [ ! -z "$(ls -A "${commit_folder}")" ]; then
  for path in "${commit_folder}"/*; do
    commit="$(basename "$path")"

    branch=$(git -C "${repo_directory}" merge-base --is-ancestor "$commit" main  && echo main  || echo "")
    [ -z "$branch" ] && branch="dev"
    baseID=$(git -C "${repo_directory}" merge-base "$commit" "$branch")
    [ ! -z "${baseID}" ] && baseID=$(git -C "$repo_directory" rev-parse --short "${baseID}")
    infos=$(git -C "${repo_directory}" show -s --format='%cs %s' "${commit}")
    infoDate=$(echo "${infos}" | sed 's/^\([^ ]*\) .*/\1/')
    infoComments=$(echo "${infos}" | sed 's/^[^ ]* \(.*\)/\1/')

    jq --arg id "$commit" --arg date "$infoDate" --arg comment "$infoComments" --arg base "$baseID" \
        ' .standalone = (.standalone // []) |
        .standalone += [{id:$id, date:$date, comment:$comment, base:$base}]
    ' "${tmp_json}" > "${tmp}" && mv "${tmp}" "${tmp_json}"
  done
fi
mv "${tmp_json}" "${output}"

(( remove_repo == 1)) && rm -rf "${repo_directory}"
