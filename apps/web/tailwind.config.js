/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#dce6fd',
          500: '#2f5bff',
          600: '#2549d6',
          700: '#1e3aae',
        },
      },
    },
  },
  plugins: [],
};
