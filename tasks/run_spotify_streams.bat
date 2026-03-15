@echo off
start "Taylor Swift - Update Streams" powershell -NoExit -Command "cd 'C:\Users\sfara\Documents\GitHub\The Taylor Swift Musuem\collectors\spotify\streams'; python update_streams.py 2>&1 | Tee-Object -FilePath run_update_streams.log -Append"
