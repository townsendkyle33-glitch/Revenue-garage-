// Test environment: a real local Postgres, fake Twilio/OpenAI endpoints. Set before any module reads config.
process.env.DATABASE_URL ??= "postgres://postgres@127.0.0.1:54329/janet_test";
process.env.PUBLIC_BASE_URL = "https://janet.test";
process.env.JANET_OWNER_PHONE = "+15615550100";
process.env.JANET_OWNER_NAME = "Kyle";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_PHONE_NUMBER = "+15615550199";
process.env.OPENAI_API_KEY = "sk-test";
process.env.JANET_SESSION_SECRET = "test-session-secret-0123456789-abcdefghij";
process.env.JANET_ADMIN_PASSWORD = "correct horse battery";
process.env.JANET_ENCRYPTION_KEY = "test-encryption-key-0123456789-abcdefghij";
process.env.JANET_WORKER_ENABLED = "false";
process.env.LOG_LEVEL = "silent";
