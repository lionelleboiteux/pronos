const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 3001;

// Enable CORS for all routes
app.use(cors());

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from backend!' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
