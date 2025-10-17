curl -X POST http://localhost:8080/api/task/new -F "name=myrun" -F "config=@./samples/test_monitor.json" -F "script=@./samples/test_monitor.sh" -F "files[]=@./samples/shell.nix" -F "args[COMMIT_ID]=3f648f016c84884d6470fc906735bb8c5da7891b"
curl -X GET http://localhost:8080/api/tasks/running

git log --graph --oneline --first-parent 3bc37034a9a9decd0a069aa810929c0e518056c9^..HEAD
git log --reverse --oneline --first-parent 3bc37034a9a9decd0a069aa810929c0e518056c9^..HEAD | awk 'NR%3==1'

sed 's/.*"name":"\([^"]*\)","id":"\([^"]*\)".*"exit_code":\([^,]*\),.*"state":"\([^"]*\)".*"time_points_ms":\[\([^,]*\),\([^]]*\)].*/\1 \2 \3 \4 \5 \6/' .steps.json | awk '{diff = ($6 - $5)/3600000; print $1, $2, $3, $4, diff}' | grep "Experiment SDOS1 0 Done" | cut -d ' ' -f 5 | sort -n | sed 's/,/./'

3f648f016 header of branch evaluation-2022

master:
3bc37034a Merge pull request #217 from tlspuffin/evaluation
6e308c703 Fix CLI parsing (#236)
c1d942d95 Downgrade LibAFL 0.9 (#238)
f0f83434c Upgrade to LibAFL 10.1 (#262)
0834f410c Fix certificates and CI (#287)
e625a6ab9 Merge pull request #286 from aeyno/fix_wolfssl_hanging
bd547aa92 Add support for OpenSSL 3 (#283)
c98e98675 fix: build on macos with asan (#302)
482ebfe1e fix CI deadlock when testing known vulnerabilities (#306)
afb3755db improve CI scripts (#301)
c2f13ccbd PUT rearchitecture: introduce C PUT harness (#305)
a8c69861a setup website tooling (#315)
0cd39c83f add getting started guide (#321)
15dda6717 Add deterministic RNG for LibreSSL and older versions of OpenSSL (#324)
8f354b6e0 ci: fix deploy step when website has not changed (#326)
1957fba63 Merge pull request #328 from tlspuffin/build/upgrade-rust-toolchain
85931c468 Merge pull request #330 from tlspuffin/refactor/fix-integration-tests
9790ca0f1 Merge pull request #337 from tlspuffin/trace_precomputations
df4b6d9b0 Merge pull request #347 from tlspuffin/pr/harness-registration
009257d47 Merge pull request #357 from tlspuffin/pr/overhaul-agent-descriptor
1ae0365ee Merge pull request #360 from tlspuffin/pr/developer-docs
0b1110854 Merge pull request #372 from tlspuffin/pr/improve-openssl-error-logging
f208cd6d5 Merge pull request #359 from tlspuffin/pr/remove-hardcoded-params-in-tls-decryption
851993669 Merge pull request #389 from tlspuffin/tls/vendors/wolfssl5x2
dfbee75a2 Merge pull request #383 from tlspuffin/cput_wolfssl
6c5d32d96 Merge pull request #397 from tlspuffin/harness_build_type
5aabb3ede Merge pull request #401 from tlspuffin/pr/tls-add-secrets-to-finished-claim
170c97ded Merge pull request #405 from tlspuffin/wolfssl_transcript_size
2ed7077aa Merge pull request #408 from tlspuffin/pr/truncate-traces-fail
2f38bf22a Merge pull request #411 from tlspuffin/pr/codec-error
e866693e0 Merge pull request #420 from tlspuffin/pr/tls-add-symbols-for-hrr

git log --graph --oneline --first-parent 3bc37034a9a9decd0a069aa810929c0e518056c9^..main | grep "Merge pull" | awk 'NR%3==1'
* 2d000bfe0 Merge pull request #417 from tlspuffin/pr/bit-mutations/rework-term-zoo
* 76d5b7b5c Merge pull request #419 from tlspuffin/pr/tls-fn-symbols-list-of-namedgroups
* 034948150 Merge pull request #409 from tlspuffin/pr/wolf-add-finished-after-sh
* 2dad52a3c Merge pull request #406 from tlspuffin/pr/new-sats
* 556e480f9 Merge pull request #400 from tlspuffin/wolfssl_c_mastersecret
* 47d1ee217 Merge pull request #386 from tlspuffin/pr/improve-execute-output
* 300534832 Merge pull request #396 from tlspuffin/wolfssl_rng
* 07e2f717e Merge pull request #392 from tlspuffin/pr/fix-openssl-not-setting-ciphers
* 60b3f3185 Merge pull request #387 from tlspuffin/pr/modular-logging
* ec1f09894 Merge pull request #376 from tlspuffin/pr/extract_knowledge_macro
* 80dff41a4 Merge pull request #379 from tlspuffin/update-readme
* afe34c1ce Merge pull request #370 from tlspuffin/pr/fix-macos-put-relocation
* 15e7d3240 Merge pull request #353 from tlspuffin/pr/adding-openssl320-and-openssl340
* 47c97cd7a Merge pull request #343 from tlspuffin/pr/bit-mutations/refactor
* aa7213ac1 Merge pull request #333 from tlspuffin/precomputations
* cd649d6bf Merge pull request #334 from tlspuffin/refactor/unified-vendor-build
* 012aa525c Merge pull request #327 from tlspuffin/new_knowledge_storage_2
* c070a2ad8 Merge pull request #310 from tlspuffin/fix-boring-determinism
* e625a6ab9 Merge pull request #286 from aeyno/fix_wolfssl_hanging
* e866693e0
* d1f510dcb
