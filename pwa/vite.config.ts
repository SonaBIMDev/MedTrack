import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "MedTrack",
        short_name: "MedTrack",
        description: "Géolocalisation d'équipements médicaux",
        theme_color: "#0d1117",
        background_color: "#0d1117",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // Augmenter la limite à 10MB pour les bundles ThatOpen/Three.js
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // Exclure les fichiers trop lourds du precache
        globIgnores: ["**/*.ifc", "**/*.wasm"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: "CacheFirst",
          },
          {
            urlPattern: /\.wasm$/,
            handler: "CacheFirst",
            options: {
              cacheName: "wasm-cache",
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
  assetsInclude: ["**/*.ifc"],
});