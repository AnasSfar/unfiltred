@echo off
start "Taylor Swift - Daily FR" powershell -NoExit -Command "cd 'C:\Users\sfara\Documents\GitHub\The Taylor Swift Musuem\collectors\spotify\charts\fr'; python daily.py 2>&1 | Tee-Object -FilePath run_daily.log -Append"
