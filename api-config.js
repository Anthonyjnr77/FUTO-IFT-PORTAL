// Default to the deployed backend URL for production. Localhost is kept only for true local development.
var isLocalDev = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol !== 'file:';
window.FUTO_API_BASE = window.FUTO_API_BASE || (isLocalDev ? 'http://localhost:3000/api' : 'https://futo-ift-api.onrender.com/api');
