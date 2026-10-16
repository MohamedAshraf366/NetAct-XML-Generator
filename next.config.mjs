/** @type {import('next').NextConfig} */
const nextConfig = {
  // node-unrar-js loads a .wasm file from disk, so it must not be bundled
  serverExternalPackages: ["node-unrar-js", "exceljs", "mdb-reader"],
};
export default nextConfig;
