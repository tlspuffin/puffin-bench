curl -X POST http://localhost:8080/task_new -F "name=myrun" -F "config=@./samples/experiment.json" -F "script=@./samples/campaign.conf" -F "files[]=@./samples/shell.nix"
