@echo off
start "Taylor Swift - Daily Global" powershell -NoExit -Command "cd 'C:\Users\sfara\Documents\GitHub\The Taylor Swift Musuem\collectors\spotify\charts\global'; python daily.py 2>&1 | Tee-Object -FilePath run_daily.log -Append"
