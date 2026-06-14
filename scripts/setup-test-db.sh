#!/bin/bash

# Setup test database on Supabase
# Usage: ./scripts/setup-test-db.sh <ACCESS_TOKEN>

set -e

if [ -z "$1" ]; then
  echo "❌ Usage: ./scripts/setup-test-db.sh <SUPABASE_ACCESS_TOKEN>"
  echo ""
  echo "To get your access token:"
  echo "1. Go to: https://app.supabase.com/account/tokens"
  echo "2. Create or copy your personal access token"
  echo "3. Run: ./scripts/setup-test-db.sh <paste-token-here>"
  exit 1
fi

ACCESS_TOKEN=$1
PROJECT_NAME="front-desk-crm-v5-test"
REGION="us-east-1"

echo "🔐 Authenticating with Supabase..."
supabase login --token "$ACCESS_TOKEN" 2>&1 | grep -i "logged\|authenticated" || true

echo "📦 Creating project: $PROJECT_NAME"
echo ""
echo "This will take ~2-3 minutes..."
echo ""

PROJECT_OUTPUT=$(supabase projects create --name "$PROJECT_NAME" --region "$REGION" --db-pass "TestPass123456!" 2>&1)
PROJECT_ID=$(echo "$PROJECT_OUTPUT" | grep -oP '(?<=ID: )[^ ]*' | head -1)

if [ -z "$PROJECT_ID" ]; then
  echo "⚠️  Could not parse project ID. Full output:"
  echo "$PROJECT_OUTPUT"
  exit 1
fi

echo "✅ Project created: $PROJECT_ID"
echo ""
echo "⏳ Waiting for project to be ready..."
sleep 15

echo "🔗 Fetching connection details..."
PROJECT_DETAILS=$(supabase projects describe "$PROJECT_ID" --output json 2>&1)

SUPABASE_URL=$(echo "$PROJECT_DETAILS" | grep -oP '"api_url":\s*"\K[^"]*' | head -1)
SUPABASE_KEY=$(echo "$PROJECT_DETAILS" | grep -oP '"anon_key":\s*"\K[^"]*' | head -1)

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "❌ Failed to extract connection details"
  echo "$PROJECT_DETAILS"
  exit 1
fi

echo ""
echo "✅ Project ready!"
echo ""
echo "📝 Saving credentials to .env"
cat > .env << EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_KEY
EOF

echo ""
echo "🚀 Running migrations..."
supabase db push --no-schema-change || supabase db push

echo ""
echo "✅ Database setup complete!"
echo ""
echo "Next steps:"
echo "1. Run tests: npm test"
echo "2. Or watch tests: npm run test:watch"
echo ""
echo "Connection details saved to .env"
