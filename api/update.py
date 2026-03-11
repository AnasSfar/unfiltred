import json
import subprocess

def handler(request):
    if request.method != "POST":
        return {
            "statusCode": 405,
            "body": json.dumps({"error": "Method not allowed"})
        }

    try:
        subprocess.run(["python", "scripts/update_streams.py"], check=True)

        return {
            "statusCode": 200,
            "body": json.dumps({"status": "update_started"})
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }