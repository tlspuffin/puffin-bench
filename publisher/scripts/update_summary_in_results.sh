gunzip "$file"
tarfile="${file%tgz}tar"
tar xf "${tarfile}" artefacts
tar --delete -f "${tarfile}" artefacts/summary.json
SummaryRun
mv summary.json artefacts/
tar rf "${tarfile}" artefacts/summary.json
gzip "${tarfile}"
mv "${tarfile}.gz" "$file"
rm -rf artefacts
done

