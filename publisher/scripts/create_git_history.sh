#! /bin/bash

[ -d "tlspuffin.git" ] && git -C tlspuffin.git fetch || git clone --bare --filter=blob:none --branch dev --single-branch https://github.com/tlspuffin/tlspuffin.git 
git -C tlspuffin.git log --first-parent --oneline --pretty=format:"%H§%ad§%s" --date=short 0b44eed3b..dev | sed 's/^\(.........\)[^§]*/\1/' | sed 's/"/\\"/g'  | awk 'BEGIN{FS="§";PREV=""} {printf("{\"id\":\"%s\",\"date\":\"%s\",\"comment\":\"%s\", \"branch\":\"dev\"},\n", $1, $2, $3);}' > .infos.txt
echo '{"commits": [' > git_history.json.tmp
cat .infos.txt >> git_history.json.tmp
cat history.txt >> git_history.json.tmp
echo ']}' >> git_history.json.tmp
rm .infos.txt
mv git_history.json.tmp git_history.json
