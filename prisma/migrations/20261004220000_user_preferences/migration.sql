-- Persistent, allowlisted user preferences (see src/user/user-preferences.ts). Existing users get an
-- empty object; the column is never read without validation.
ALTER TABLE "User" ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}';
