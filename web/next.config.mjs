/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@gamevault/shared"],
  webpack: (config, { webpack }) => {
    // Optional deps of RainbowKit's coinbase connector chain that we never
    // hit at runtime (x402 = Coinbase payments protocol; MetaMask RN storage)
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^(@x402\/|@react-native-async-storage)/ }));
    // wagmi/walletconnect optional pretty-logger
    config.resolve.fallback = { ...config.resolve.fallback, "pino-pretty": false };
    return config;
  },
};

export default nextConfig;
