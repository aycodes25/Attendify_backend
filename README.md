# Attendify Backend

This is the backend service for Attendify, built with NestJS. It handles face recognition via `face-api.js`, interacts with the Supabase database via the `@supabase/supabase-js` client, and provides real-time WebSockets to the frontend.

## Prerequisites

- Node.js (v18+)
- npm

## Getting Started

1. Install dependencies:
   ```bash
   npm install --legacy-peer-deps
   ```

2. Set up your environment variables by creating a `.env` file in the root of the backend directory:
   ```env
   SUPABASE_URL="https://your-project.supabase.co"
   SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
   PORT=3001
   ```

3. Ensure you have the `face-api.js` models in the `models/` directory.

4. Start the development server:
   ```bash
   npm run start:dev
   ```
   The backend will start on `http://localhost:3001`.

## Tech Stack
- **Framework**: NestJS
- **Database/Auth Client**: Supabase JS Client (Service Role)
- **Face Recognition**: face-api.js (using canvas for Node.js)
- **Websockets**: socket.io
