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
        // Ne pas mettre le fichier IFC en cache (trop lourd)
        globIgnores: ["**/*.ifc"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: "CacheFirst",
          },
        ],
      },
    }),
  ],
  // Nécessaire pour les fichiers WASM de web-ifc
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
  assetsInclude: ["**/*.ifc"],
});
