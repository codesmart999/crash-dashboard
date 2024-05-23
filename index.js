const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8000;
const DB_PATH = 'data/games.db'; // SQLite database file path

// Create SQLite database connection
const db = new sqlite3.Database(DB_PATH);

// Create 'games' table if it doesn't exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER,
        crash_value REAL NOT NULL,
        attempted_bet_amount REAL DEFAULT 0,
        real_bet_amount REAL DEFAULT 0,
        payout REAL DEFAULT 0,
        balance_before REAL DEFAULT 0,
        balance_after REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS script_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        is_running BOOLEAN NOT NULL,
        message TEXT,
        reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(cors());
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.static('public'));

let scriptStatus = { isRunning: false, errorMessage: '' };
let balance = 0;

// Handle WebSocket connections
wss.on('connection', (ws) => {
    // Send initial data to the client when connected
    ws.send(JSON.stringify({ scriptStatus, balance }));

    // Listen for messages from the client (if needed)
    ws.on('message', (message) => {
        console.log(`Received message from client: ${message}`);
    });
});

// API to import data from CSV files into SQLite database
app.get('/api/import_csv', (req, res) => {
    const dataFolder = 'data/';

    // Read all CSV files in the data folder
    fs.readdir(dataFolder, (err, files) => {
        if (err) {
            res.status(500).json({ message: 'Error reading data folder', error: err });
            return;
        }

        files.forEach(file => {
            console.log('parsing...', file);
            if (path.extname(file).toLowerCase() === '.csv') {
                const filePath = path.join(dataFolder, file);
                fs.readFile(filePath, 'utf-8', (err, content) => {
                    if (err) {
                        console.error(`Error reading file ${filePath}`, err);
                        return;
                    }

                    // Parse CSV content and insert into database if game_id doesn't exist
                    const lines = content.trim().split('\n');
                    lines.forEach(line => {
                        const [game_info, crash_value] = line.split(',');
                        const [_, game_id] = game_info.split(' ');
                        
                        const selectSql = 'SELECT * FROM games WHERE game_id = ?';
                        db.get(selectSql, [game_id], (err, row) => {
                            if (!row) {
                                const sql = 'INSERT OR IGNORE INTO games (game_id, crash_value) VALUES (?, ?)';
                                const values = [parseInt(game_id), parseFloat(crash_value)];
                                db.run(sql, values, function(err) {
                                    if (err) {
                                        console.error(`Error inserting data for game_id ${game_id}`, err);
                                    }
                                });
                            }
                        });
                    });
                });
            }
        });

        res.status(200).json({ message: 'CSV files imported successfully' });
    });
});

// API to export data as CSV
app.get('/api/export_csv', (req, res) => {
    const sql = 'SELECT * FROM games ORDER BY game_id ASC'; // Modify the query as needed
    db.all(sql, (err, rows) => {
        if (err) {
            res.status(500).json({ message: 'Error fetching data', error: err });
            return;
        }

        // Format data as CSV
        const csvData = rows.map(row => `${row.game_id},${row.crash_value}`).join('\n');
        const csvFilePath = path.join(__dirname, 'data', 'exported_data.csv');

        // Write CSV data to file
        fs.writeFile(csvFilePath, csvData, (err) => {
            if (err) {
                res.status(500).json({ message: 'Error exporting data to CSV', error: err });
                return;
            }

            // Set response headers to trigger file download
            res.setHeader('Content-Disposition', 'attachment; filename=exported_data.csv');
            res.setHeader('Content-Type', 'text/csv');

            // Stream the file to the client
            const fileStream = fs.createReadStream(csvFilePath);
            fileStream.pipe(res);
        });
    });
});

// API to clean data from the 'games' table in SQLite database
app.get('/api/clean_data', (req, res) => {
    const sql = 'DELETE FROM games';
    db.run(sql, function(err) {
        if (err) {
            res.status(500).json({ message: 'Error cleaning data', error: err });
        } else {
            res.status(200).json({ message: 'Data cleaned successfully' });
        }
    });
});

// API to serve data to frontend
app.get('/api/data', (req, res) => {
    const sql = 'SELECT * FROM games ORDER BY game_id ASC'; // Modify the query as needed
    db.all(sql, (err, rows) => {
        if (err) {
            res.status(500).json({ message: 'Error fetching data', error: err });
        } else {
            res.json(rows);
        }
    });
});

app.post('/api/bet_placed', (req, res) => {
    const { game_id, attempted_bet_amount, real_bet_amount, payout, balance } = req.body;
    if (!game_id) {
        res.status(400).json({ message: 'game_id is required.' });
        return;
    }

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            scriptStatus.isRunning = true;
            scriptStatus.errorMessage = '';

            client.send(JSON.stringify({ scriptStatus, balance, bet_placed: {
                attempted_bet_amount,
                real_bet_amount,
                payout
            } }));
        }
    });

    const sql = 'INSERT INTO games (game_id, crash_value, attempted_bet_amount, real_bet_amount, payout, balance_before) VALUES (?, ?, ?, ?, ?, ?)';
    const values = [game_id, 0, attempted_bet_amount, real_bet_amount, payout, balance]; // Assuming crash_value is 0 by default
    db.run(sql, values, function(err) {
        if (err) {
            res.status(500).json({ message: 'Error inserting data', error: err });
        } else {
            res.status(200).json({ message: 'Data added successfully' });
        }
    });
});

app.post('/api/game_ended', (req, res) => {
    let { game_id, crash_value, balance } = req.body;
    if (!game_id || !crash_value) {
        res.status(400).json({ message: 'game_id and crash_value are required' });
        return;
    }

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ balance }));
        }
    });

    // Check if the game with the same game_id exists
    const selectSql = 'SELECT * FROM games WHERE game_id = ?';
    db.get(selectSql, [game_id], (err, row) => {
        if (err) {
            res.status(500).json({ message: 'Error checking game existence', error: err });
            return;
        }

        let profit = 0;
        if (row) {
            // Game with the same game_id exists
            // Calculate profit based on the change in balance
            balance = parseFloat(balance);

            const previousBalance = parseFloat(row.balance_before);
            const previousRealBetAmount = row.real_bet_amount;

            if (balance > previousBalance) {
                profit = (balance - previousBalance) - previousRealBetAmount;
            } else {
                profit = -previousRealBetAmount;
            }
            // Update the existing record
            const updateSql = 'UPDATE games SET crash_value = ?, balance_after = ?, profit = ? WHERE game_id = ?';
            const updateValues = [crash_value, balance, profit.toFixed(5), game_id];
            db.run(updateSql, updateValues, function(err) {
                if (err) {
                    res.status(500).json({ message: 'Error updating game record', error: err });
                } else {
                    res.status(200).json({ message: `Game ${game_id} record updated successfully` });
                }
            });
        } else {
            // Game with the same game_id does not exist, insert a new record
            const insertSql = 'INSERT INTO games (game_id, crash_value, balance_before, balance_after) VALUES (?, ?, ?, ?)';
            const insertValues = [game_id, crash_value, balance, balance];
            db.run(insertSql, insertValues, function(err) {
                if (err) {
                    res.status(500).json({ message: 'Error inserting game record', error: err });
                } else {
                    res.status(200).json({ message: `New game ${game_id}  record inserted successfully` });
                }
            });
        }

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ balance, game_ended: {
                    game_id,
                    crash_value,
                    profit: profit.toFixed(5)
                } }));
            }
        });
    });
});

app.post('/api/add_games', (req, res) => {
    const { data } = req.body;
    if (!Array.isArray(data)) {
        res.status(400).json({ message: 'Array of game data is required' });
        return;
    }

    // Keep track of game_ids already inserted
    const existingGameIds = new Set();

    // Check if the game with the same game_id already exists
    const selectSql = 'SELECT game_id FROM games WHERE game_id = ?';
    data.forEach(game => {
        const { game_id, crash_value } = game;
        if (!game_id || !crash_value) {
            res.status(400).json({ message: 'game_id and crash_value are required for each game' });
            return;
        }

        db.get(selectSql, [game_id], (err, row) => {
            if (err) {
                console.error('Error checking game existence:', err);
                return;
            }

            // If the game with the same game_id doesn't exist, insert it
            if (!row && !existingGameIds.has(game_id)) {
                existingGameIds.add(game_id);

                // Insert the game data into the table
                const insertSql = 'INSERT INTO games (game_id, crash_value) VALUES (?, ?)';
                const insertValues = [game_id, crash_value];
                db.run(insertSql, insertValues, function(err) {
                    if (err) {
                        console.error('Error inserting game record:', err);
                    } else {
                        console.log(`New game ${game_id} record inserted successfully`);
                    }
                });
            }
        });
    });

    res.status(200).json({ message: 'Games data processed successfully' });
});


// API to indicate script started
app.post('/api/script_started', (req, res) => {
    const { balance } = req.body;
    const sql = 'INSERT INTO script_status (is_running) VALUES (?)';
    const values = [true];
    db.run(sql, values, function(err) {
        if (err) {
            res.status(500).json({ message: 'Error indicating script started', error: err });
        } else {
            res.status(200).json({ message: 'Script started successfully' });
        }
    });

    scriptStatus.isRunning = true;
    scriptStatus.errorMessage = '';
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ scriptStatus, balance }));
        }
    });
});

// API to indicate script stopped
app.post('/api/script_stopped', (req, res) => {
    const { error } = req.body;
    const sql = 'INSERT INTO script_status (is_running, message) VALUES (?, ?)';
    const values = [false, error];
    db.run(sql, values, function(err) {
        if (err) {
            res.status(500).json({ message: 'Error indicating script stopped', error: err });
        } else {
            res.status(200).json({ message: 'Script stopped!' });
        }
    });

    scriptStatus.isRunning = false;
    scriptStatus.errorMessage = error;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ scriptStatus }));
        }
    });
});

// API to get the script status
app.get('/api/get_script_status', (req, res) => {
    const sql = 'SELECT * FROM script_status ORDER BY id DESC LIMIT 1';
    db.get(sql, (err, row) => {
        if (err) {
            res.status(500).json({ message: 'Error getting script status', error: err });
        } else {
            res.status(200).json(row);
        }
    });
});

app.get('/api/load_all_games', (req, res) => {
    const sql = `
        SELECT *, 
               datetime(reported_at, 'localtime') as converted_reported_at 
        FROM games 
        ORDER BY game_id DESC
        LIMIT 3000`;
    
    db.all(sql, (err, rows) => {
        if (err) {
            res.status(500).json({ message: 'Error fetching data', error: err });
        } else {
            res.json(rows.reverse());
        }
    });
});

app.get('/api/analyze/:last_n_games?', (req, res) => {
    let last_n_games = req.params.last_n_games || 3000;

    // Retrieve the last N games from the database
    const sql = `
        SELECT game_id, crash_value 
        FROM games 
        WHERE crash_value > 0
        ORDER BY game_id DESC 
        LIMIT ?`;
    
    db.all(sql, [parseInt(last_n_games)], (err, rows) => {
        if (err) {
            res.status(500).json({ message: 'Error fetching data', error: err });
            return;
        }

        // Convert crash values to numbers
        const crashValues = rows.map(row => {
            if (typeof row.crash_value == "string")
                return parseFloat(row.crash_value.replace(",", "")); // without commas
            else
                return row.crash_value;
        });

        // Array of values to analyze
        const arr_values = [50, 100, 150, 300, 500, 1000, 10, 25];
        const arr_rates_for_value = [1.98, 0.99, 0.66, 0.33, 0.198, 0.099, 9.9, 3.96];

        // Initialize result object
        let analysisResult = {};

        // Loop through each value to analyze
        arr_values.forEach((value, index) => {
            let lastAppearanceIndex = -1;
            for (let i = 0; i < crashValues.length; i++) {
                if (crashValues[i] >= value) {
                    lastAppearanceIndex = i;
                    break;
                }
            }
            const gamesAgo = lastAppearanceIndex !== -1 ? lastAppearanceIndex + 1 : 'None';

            // Initialize counters for different ranges
            const appearanceCounts = {
                last_50_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '50', hidden: false},
                last_100_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '100', hidden: false},
                last_150_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '150', hidden: false},
                last_300_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '300', hidden: false},
                last_500_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '500', hidden: false},
                last_1000_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '1000', hidden: false},
                last_3000_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '3000', hidden: false},
                last_10000_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: '10000', hidden: false},
                last_n_games: {count: 0, ratio: 0, avg_count: 0, color: 'green', games: last_n_games, hidden: false}
            };

            // Count appearances within different ranges
            crashValues.slice(0, 50).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_50_games.count++;
                }
            });
            appearanceCounts.last_50_games.ratio = appearanceCounts.last_50_games.count / 50 * 100; // percentage
            appearanceCounts.last_50_games.avg_count = arr_rates_for_value[index] * 50 / 100;
            if (value <= 50 && appearanceCounts.last_50_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_50_games.color = "red";
            else if (value > 50)
                appearanceCounts.last_50_games.hidden = true;

            crashValues.slice(0, 100).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_100_games.count++;
                }
            });
            appearanceCounts.last_100_games.ratio = appearanceCounts.last_100_games.count / 100 * 100; // percentage
            appearanceCounts.last_100_games.avg_count = arr_rates_for_value[index] * 100 / 100;
            if (value <= 100 && appearanceCounts.last_100_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_100_games.color = "red";
            else if (value > 100)
                appearanceCounts.last_100_games.hidden = true;

            crashValues.slice(0, 150).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_150_games.count++;
                }
            });
            appearanceCounts.last_150_games.ratio = appearanceCounts.last_150_games.count / 150 * 100; // percentage
            appearanceCounts.last_150_games.avg_count = arr_rates_for_value[index] * 150 / 100;
            if (value <= 150 && appearanceCounts.last_150_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_150_games.color = "red";
            else if (value > 150)
                appearanceCounts.last_150_games.hidden = true;

            crashValues.slice(0, 300).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_300_games.count++;
                }
            });
            appearanceCounts.last_300_games.ratio = appearanceCounts.last_300_games.count / 300 * 100; // percentage
            appearanceCounts.last_300_games.avg_count = arr_rates_for_value[index] * 300 / 100;
            if (value <= 300 && appearanceCounts.last_300_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_300_games.color = "red";
            else if (value > 300)
                appearanceCounts.last_300_games.hidden = true;

            crashValues.slice(0, 500).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_500_games.count++;
                }
            });
            appearanceCounts.last_500_games.ratio = appearanceCounts.last_500_games.count / 500 * 100; // percentage
            appearanceCounts.last_500_games.avg_count = arr_rates_for_value[index] * 500 / 100;
            if (value <= 500 && appearanceCounts.last_500_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_500_games.color = "red";
            else if (value > 500)
                appearanceCounts.last_500_games.hidden = true;

            crashValues.slice(0, 1000).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_1000_games.count++;
                }
            });
            appearanceCounts.last_1000_games.ratio = appearanceCounts.last_1000_games.count / 1000 * 100; // percentage
            appearanceCounts.last_1000_games.avg_count = arr_rates_for_value[index] * 1000 / 100;
            if (value <= 1000 && appearanceCounts.last_1000_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_1000_games.color = "red";
            else if (value > 1000)
                appearanceCounts.last_1000_games.hidden = true;

            crashValues.slice(0, 3000).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_3000_games.count++;
                }
            });
            appearanceCounts.last_3000_games.ratio = appearanceCounts.last_3000_games.count / 3000 * 100; // percentage
            appearanceCounts.last_3000_games.avg_count = arr_rates_for_value[index] * 3000 / 100;
            if (value <= 3000 && appearanceCounts.last_3000_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_3000_games.color = "red";
            else if (value > 3000)
                appearanceCounts.last_3000_games.hidden = true;

            crashValues.slice(0, 10000).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_10000_games.count++;
                }
            });
            appearanceCounts.last_10000_games.ratio = appearanceCounts.last_10000_games.count / 10000 * 100; // percentage
            appearanceCounts.last_10000_games.avg_count = arr_rates_for_value[index] * 10000 / 100;
            if (value <= 10000 && appearanceCounts.last_10000_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_10000_games.color = "red";
            else if (value > 10000)
                appearanceCounts.last_10000_games.hidden = true;

            crashValues.slice(0, last_n_games).forEach(val => {
                if (val >= value) {
                    appearanceCounts.last_n_games.count++;
                }
            });
            appearanceCounts.last_n_games.ratio = appearanceCounts.last_n_games.count / last_n_games * 100; // percentage
            appearanceCounts.last_n_games.avg_count = arr_rates_for_value[index] * last_n_games / 100;
            if (value <= last_n_games && appearanceCounts.last_n_games.ratio > arr_rates_for_value[index] + 0.02)
                appearanceCounts.last_n_games.color = "red";
            else if (value > last_n_games)
                appearanceCounts.last_n_games.hidden = true;

            // Add analysis results to the result object
            analysisResult[value] = {
                games_ago: gamesAgo,
                expected_rate: arr_rates_for_value[index],
                appearance_counts: appearanceCounts
            };
        });

        // Sort analysisResult by keys in ascending order
        // analysisResult = Object.keys(analysisResult)
        //     .sort((a, b) => parseFloat(a) - parseFloat(b))
        //     .reduce((acc, key) => ({
        //         ...acc,
        //         [key]: analysisResult[key]
        //     }), {});

        const sortedAnalysisResult = [];

        // Loop through arr_values to maintain the desired order
        arr_values.forEach(value => {
            // Check if the value exists in analysisResult
            if (analysisResult[value]) {
                // Add the value and its corresponding analysis result to sortedAnalysisResult
                sortedAnalysisResult.push({ value, result: analysisResult[value] });
            }
        });

        // Send the analysis result as a response
        res.status(200).json(sortedAnalysisResult);
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
