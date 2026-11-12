/// <reference types="vite/client" />

/** Which version this is: "V_10 10-01" — day, month (India time) and that day's version number (vite.config.ts). */
declare const __BUILD_STAMP__: string
/** The commit this build was made from. */
declare const __BUILD_COMMIT__: string
/** Started with SHRI_API=real (vite.config.ts): the SHRI_HEALTH API is the only source of patients,
 *  doctors and bookings. Read it through REAL_API (src/api/client.ts). */
declare const __SHRI_REAL_API__: boolean
