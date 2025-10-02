#!/bin/bash

# Re-ingest all documents from pdfs_txt directory
WORKER_URL="https://irt-bot.rheabdsouza.workers.dev"

for file in pdfs_txt/*.txt; do
  filename=$(basename "$file" .txt)
  echo "Ingesting $filename..."
  
  # Read file content and escape for JSON
  content=$(cat "$file" | jq -Rs .)
  
  # Send to /ingest endpoint
  curl -X POST "$WORKER_URL/ingest" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"$filename\",\"title\":\"$(echo $filename | sed 's/-/ /g' | sed 's/\b\(.\)/\u\1/g')\",\"text\":$content}"
  
  echo ""
  echo "---"
done

echo "Done!"
