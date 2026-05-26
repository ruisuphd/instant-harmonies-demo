/**
 * Two-Stage Client for Predictive JI Tuning
 * Stage 1: Fingerprint Identification
 * Stage 2: Parangonar Score Following
 */

class TwoStageClient {
    constructor(serverUrl = 'http://localhost:5005') {
        this.serverUrl = serverUrl;
        this.socket = null;
        this.connected = false;
        
        // Callbacks
        this.onPieceIdentified = null;
        this.onHarmonicPrediction = null;
        this.onScoreFollowing = null;
        this.onPositionUpdate = null;
        this.onStatusChange = null;
        
        // State
        this.systemState = 'idle';
        this.identifiedPiece = null;
        this.currentPosition = 0;
        this.harmonicPrediction = null;
    }
    
    /**
     * Connect to server
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                if (typeof io === 'undefined') {
                    const script = document.createElement('script');
                    script.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
                    script.onload = () => this._initializeSocket(resolve, reject);
                    script.onerror = () => reject(new Error('Failed to load Socket.IO'));
                    document.head.appendChild(script);
                } else {
                    this._initializeSocket(resolve, reject);
                }
            } catch (error) {
                reject(error);
            }
        });
    }
    
    _initializeSocket(resolve, reject) {
        this.socket = io(this.serverUrl, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });
        
        this.socket.on('connect', () => {
            const wasConnected = this.connected;
            this.connected = true;
            console.log('Connected to two-stage server' + (wasConnected ? ' (reconnect)' : ''));

            // Only reset state on initial connection, not reconnects
            // Reconnects preserve the server-side state via the system_status event
            if (!wasConnected) {
                this.systemState = 'idle';
                this.identifiedPiece = null;
                this.currentPosition = 0;
                this.harmonicPrediction = null;
                this.clearAllUI();
            }

            resolve();
        });
        
        this.socket.on('disconnect', () => {
            this.connected = false;
            console.log('Disconnected from server');
            this.systemState = 'idle';
            this.identifiedPiece = null;
            this.currentPosition = 0;
            this.harmonicPrediction = null;
            window.clearBackendHarmonicPrediction?.();
        });
        
        // Stage 1: Piece identified
        this.socket.on('piece_identified', (data) => {
            console.log('Piece identified:', data.piece);
            this.identifiedPiece = data.piece;
            this.systemState = 'identified';
            
            if (this.onPieceIdentified) {
                this.onPieceIdentified(data);
            }
            
            // Update UI
            this.updateIdentificationDisplay(data);
        });

        this.socket.on('harmonic_prediction', (data) => {
            this.harmonicPrediction = {
                ...data,
                receivedAtMs: Date.now()
            };

            if (this.onHarmonicPrediction) {
                this.onHarmonicPrediction(data);
            }

            if (this.systemState !== 'following' && this.systemState !== 'score_following_active') {
                if (window.applyBackendHarmonicPrediction) {
                    window.applyBackendHarmonicPrediction(this.harmonicPrediction);
                } else {
                    this.updateHarmonicDisplay(this.harmonicPrediction);
                }
            }
        });
        
        // Stage 2: Score following started
        this.socket.on('score_following_started', (data) => {
            console.log('Score following started');
            this.systemState = 'following';
            this.harmonicPrediction = null;
            window.clearBackendHarmonicPrediction?.();
            
            if (this.onScoreFollowing) {
                this.onScoreFollowing(data);
            }
            
            this.updateScoreFollowingDisplay(data);
            
            // Update main key display to show MusicXML key (replacing ensemble detection)
            if (data.initial_key) {
                const keyNameEl = document.getElementById('keyName');
                const keyConfEl = document.getElementById('keyConfidence');
                const keyMethodEl = document.getElementById('keyMethod');
                const statusEl = document.getElementById('detectionStatus');
                
                if (keyNameEl) {
                    keyNameEl.textContent = data.initial_key;
                }
                if (keyConfEl) {
                    keyConfEl.textContent = 'from MusicXML score';
                }
                if (keyMethodEl) {
                    keyMethodEl.textContent = 'Source: MusicXML Key Signature';
                }
                if (statusEl) {
                    const currentText = statusEl.textContent;
                    const tuningPart = currentText.includes('|') ? currentText.split('|')[1] : '';
                    statusEl.textContent = `Status: Using MusicXML key (${data.initial_key})${tuningPart ? ' |' + tuningPart : ''}`;
                }

                // Cache the last-rendered main-display key so position_update can detect changes
                this._lastMainDisplayKey = data.initial_key;
                console.log(`Main display updated to MusicXML key: ${data.initial_key}`);
            }
            
            // Apply initial MTS tuning from MusicXML key signature
            if (data.initial_key && data.tuning_source === 'musicxml') {
                console.log(`Initial key from MusicXML: ${data.initial_key} (${data.is_minor ? 'minor' : 'major'})`);
                // Trigger MTS tuning for the initial key
                if (window.applyJITuning) {
                    // Create a minimal entry to trigger MTS tuning
                    window.applyJITuning({
                        0: [{
                            note_id: 'initial_key_setup',
                            key: data.initial_key,
                            is_minor: data.is_minor,
                            source: 'musicxml_key_signature',
                            cents: 0,
                            timestamp: Date.now() / 1000
                        }]
                    });
                }
            }
        });
        
        // Score not available - fallback mode
        this.socket.on('score_not_available', (data) => {
            console.warn('Score not available:', data.message);
            this.updateFallbackDisplay(data);
        });
        
        // Position updates (real-time)
        this.socket.on('position_update', (data) => {
            this.currentPosition = data.position;

            if (this.onPositionUpdate) {
                this.onPositionUpdate(data);
            }

            // Update position display
            this.updatePositionDisplay(data);

            // Sync the main key display when score-following crosses a key-signature change.
            // Without this, the main display remains stuck on the piece's initial key even though
            // position_update already reports the correct current_key inside the score-follow panel.
            // See research_data/engine_review_2026-04-19.md §A7.
            if (data.current_key && data.current_key !== this._lastMainDisplayKey) {
                this._lastMainDisplayKey = data.current_key;
                const keyNameEl = document.getElementById('keyName');
                const keyConfEl = document.getElementById('keyConfidence');
                const keyMethodEl = document.getElementById('keyMethod');
                const statusEl = document.getElementById('detectionStatus');

                const modeLabel = data.current_key_is_minor ? 'minor' : 'major';
                if (keyNameEl) keyNameEl.textContent = data.current_key;
                if (keyConfEl) keyConfEl.textContent = `from MusicXML score (${modeLabel})`;
                if (keyMethodEl) keyMethodEl.textContent = 'Source: MusicXML Key Signature';
                if (statusEl) {
                    const currentText = statusEl.textContent;
                    const tuningPart = currentText.includes('|') ? currentText.split('|')[1] : '';
                    statusEl.textContent = `Status: Following score — key ${data.current_key} (${modeLabel})${tuningPart ? ' |' + tuningPart : ''}`;
                }
                console.log(`Main display synced to score-follow key: ${data.current_key} (${modeLabel})`);
            }

            // Display predicted notes
            if (data.predicted_notes) {
                this.displayPredictedNotes(data.predicted_notes);
            }

            // Apply JI tuning (if callback provided)
            if (data.ji_ratios && window.applyJITuning) {
                window.applyJITuning(data.ji_ratios);
            }
        });
        
        // Identification attempt feedback (including failures)
        this.socket.on('identification_attempt', (data) => {
            const statusEl = document.getElementById('stage1Status');
            if (!statusEl) return;

            if (!data.success) {
                const guess = data.best_guess
                    ? 'Best guess: ' + data.best_guess.substring(0, 50) + '... (' + data.best_confidence.toFixed(1) + '%)'
                    : 'No matching pieces found';
                statusEl.textContent = 'Listening... ' + data.buffer_size + ' notes — ' + guess + ' — ' + data.message;
                statusEl.style.backgroundColor = 'lightyellow';
            }
        });

        this.socket.on('system_status', (data) => {
            const previousState = this.systemState;
            this.systemState = data.state;

            if (data.state === 'idle' && previousState !== 'idle') {
                this.harmonicPrediction = null;
                this.clearAllUI();
            }

            // Show collection progress when collecting notes
            if (data.state === 'collecting_midi' && previousState !== 'piece_identified' && previousState !== 'score_following_active') {
                const statusEl = document.getElementById('stage1Status');
                if (statusEl && !statusEl.textContent.includes('Identified') && !statusEl.textContent.includes('Listening')) {
                    const threshold = 30;
                    const progress = Math.min(100, Math.round((data.buffer_size / threshold) * 100));
                    statusEl.textContent = 'Collecting... ' + data.buffer_size + ' notes (need ' + threshold + ' to identify)';
                    statusEl.style.backgroundColor = progress >= 100 ? 'lightyellow' : 'lightcyan';
                }
            }

            if (this.onStatusChange) {
                this.onStatusChange(data);
            }
        });

        // Errors
        this.socket.on('error', (data) => {
            console.error('Server error:', data.message);
        });
    }
    
    /**
     * Send MIDI note to server
     */
    sendMidiNote(pitch, velocity) {
        if (!this.connected || !this.socket) {
            console.warn('Cannot send MIDI note: not connected to server');
            return false;
        }
        
        // Validate inputs
        if (typeof pitch !== 'number' || pitch < 0 || pitch > 127) {
            console.error(`Invalid pitch: ${pitch}`);
            return false;
        }
        if (typeof velocity !== 'number' || velocity < 0 || velocity > 127) {
            console.error(`Invalid velocity: ${velocity}`);
            return false;
        }
        
        // Debug logging - uncomment to trace notes
        // console.log(`[TwoStage] Sending note: pitch=${pitch}, velocity=${velocity}`);
        
        this.socket.emit('midi_note', {
            pitch: Math.round(pitch),
            velocity: Math.round(velocity),
            timestamp: Date.now() / 1000
        });
        
        return true;
    }
    
    reset() {
        if (this.connected && this.socket) {
            this.socket.emit('reset');
            this.systemState = 'idle';
            this.identifiedPiece = null;
            this.currentPosition = 0;
        }
        this.clearAllUI();
    }
    
    clearAllUI() {
        this.harmonicPrediction = null;
        this._lastMainDisplayKey = null;
        const statusEl = document.getElementById('stage1Status');
        if (statusEl) {
            statusEl.textContent = 'Connected — Start playing to identify the piece';
            statusEl.style.backgroundColor = 'lightcyan';
        }

        const resultsEl = document.getElementById('songResults');
        if (resultsEl) resultsEl.textContent = '';

        const progressEl = document.getElementById('scoreProgress');
        if (progressEl) progressEl.textContent = '';

        const predictedEl = document.getElementById('predictedNotes');
        if (predictedEl) predictedEl.textContent = '';

        if (window.applyJITuning) {
            window.applyJITuning({});
        }
        window.clearBackendHarmonicPrediction?.();
    }
    
    updateIdentificationDisplay(data) {
        const statusEl = document.getElementById('stage1Status');
        const resultsEl = document.getElementById('songResults');
        const pieceName = (data.piece || 'Unknown piece').substring(0, 80);
        const confidence = typeof data.confidence === 'number' ? data.confidence.toFixed(1) : '?';

        if (statusEl) {
            statusEl.textContent = 'Identified: ' + pieceName + ' (' + confidence + '%) — Loading score...';
            statusEl.style.backgroundColor = 'palegreen';
        }

        if (resultsEl && Array.isArray(data.alternatives) && data.alternatives.length > 0) {
            // Build alternatives list using DOM methods (no innerHTML)
            resultsEl.textContent = '';
            const header = document.createElement('strong');
            header.textContent = 'Alternative matches:';
            resultsEl.appendChild(header);
            data.alternatives.forEach((alt, idx) => {
                const div = document.createElement('div');
                div.className = 'small';
                const altName = (alt.piece || '').substring(0, 60);
                const altConf = typeof alt.confidence === 'number' ? alt.confidence.toFixed(1) : '?';
                div.textContent = (idx + 2) + '. ' + altName + '... (' + altConf + '%)';
                resultsEl.appendChild(div);
            });
        }
    }
    
    /**
     * Update score following display
     */
    updateScoreFollowingDisplay(data) {
        const statusEl = document.getElementById('stage1Status');
        
        if (statusEl) {
            const keyInfo = data.initial_key 
                ? `<strong>Key:</strong> ${data.initial_key} (${data.is_minor ? 'minor' : 'major'}) - from MusicXML<br>` 
                : '';
            const keyChanges = data.key_changes_count > 1 
                ? `<strong>Key changes:</strong> ${data.key_changes_count} in this piece<br>` 
                : '';
            
            statusEl.innerHTML = `
                <strong>🎵 Score Following Active</strong><br>
                <strong>Piece:</strong> ${data.piece.substring(0, 80)}...<br>
                <strong>Score:</strong> ${data.score_length} notes<br>
                ${keyInfo}
                ${keyChanges}
                <strong>Tuning:</strong> Predictive JI from MusicXML key signatures<br>
                <strong>Status:</strong> Tracking position in real-time
            `;
            statusEl.style.backgroundColor = 'lightblue';
        }
    }
    
    /**
     * Update position display with key information
     */
    updatePositionDisplay(data) {
        const progressEl = document.getElementById('scoreProgress');
        
        if (progressEl) {
            const percent = (data.progress * 100).toFixed(1);
            
            // Key information from MusicXML
            const currentKey = data.current_key || '—';
            const keyMode = data.current_key_is_minor ? 'minor' : 'major';
            const tuningSource = data.tuning_source === 'musicxml' ? '📜 from score' : '🎹 detected';
            
            // Upcoming key changes
            let keyChangeInfo = '';
            if (data.upcoming_key_changes && data.upcoming_key_changes.length > 0) {
                const nextChange = data.upcoming_key_changes[0];
                keyChangeInfo = `<div style="color: olive; font-size: 11px; margin-top: 5px;">
                    ⚠️ Key change to <strong>${nextChange.key}</strong> in ${nextChange.notes_until_change} notes
                </div>`;
            }
            
            progressEl.innerHTML = `
                <div style="margin: 10px 0;">
                    <strong>Position:</strong> Note ${data.position} / ${data.total_notes} (${percent}%)
                    <div style="background: lightgray; height: 8px; border-radius: 4px; margin-top: 5px;">
                        <div style="background: steelblue; height: 100%; width: ${percent}%; border-radius: 4px; transition: width 0.3s;"></div>
                    </div>
                    <div style="margin-top: 8px; font-size: 12px;">
                        <strong>Current Key:</strong> ${currentKey} (${keyMode}) ${tuningSource}
                    </div>
                    ${keyChangeInfo}
                </div>
            `;
        }
    }
    
    /**
     * Display predicted notes with key information
     */
    displayPredictedNotes(predicted) {
        const predictedEl = document.getElementById('predictedNotes');
        
        if (predictedEl && predicted.length > 0) {
            let html = '<div style="margin: 10px 0; font-family: monospace; font-size: 12px;">';
            html += '<strong>Predicted Notes (next 2 seconds):</strong><br>';
            
            let prevKey = null;
            predicted.forEach((note, idx) => {
                const noteName = this.midiToNoteName(note.pitch);
                const timing = note.time_offset.toFixed(2);
                const keyInfo = note.key ? ` [${note.key}]` : '';
                
                // Highlight key changes
                const keyChanged = note.key && prevKey && note.key !== prevKey;
                const style = keyChanged ? 'color: olive; font-weight: bold;' : '';
                const keyChangeMarker = keyChanged ? ' ← KEY CHANGE' : '';
                
                html += `<span style="${style}">${idx + 1}. ${noteName} (pitch ${note.pitch})${keyInfo} in ${timing}s${keyChangeMarker}</span><br>`;
                prevKey = note.key;
            });
            
            html += '</div>';
            predictedEl.innerHTML = html;
        }
    }
    
    /**
     * Update fallback display when score not available
     */
    updateFallbackDisplay(data) {
        const statusEl = document.getElementById('stage1Status');
        
        if (statusEl) {
            statusEl.innerHTML = `
                <strong>ℹ️ Score Not Available</strong><br>
                <strong>Identified:</strong> ${data.piece.substring(0, 80)}...<br>
                <strong>Note:</strong> ${data.note}<br>
                <strong>Mode:</strong> Reactive JI tuning (no prediction)<br>
                <em>Score following requires MusicXML file</em>
            `;
            statusEl.style.backgroundColor = 'lightyellow';
        }
    }

    updateHarmonicDisplay(data) {
        const keyNameEl = document.getElementById('keyName');
        const keyConfEl = document.getElementById('keyConfidence');
        const keyMethodEl = document.getElementById('keyMethod');

        if (keyNameEl) keyNameEl.textContent = data.key;
        if (keyConfEl) keyConfEl.textContent = `Confidence: ${(Number(data.confidence) * 100).toFixed(1)}%`;
        if (keyMethodEl) keyMethodEl.textContent = 'Source: backend harmonic model';
    }
    
    /**
     * Convert MIDI pitch to note name
     */
    midiToNoteName(pitch) {
        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(pitch / 12) - 1;
        const noteName = notes[pitch % 12];
        return `${noteName}${octave}`;
    }
}

// Initialize global client
window.twoStageClient = new TwoStageClient();

// Auto-connect on page load
window.addEventListener('load', () => {
    console.log('Connecting to two-stage server...');
    window.twoStageClient.connect()
        .then(() => {
            console.log('Two-stage client ready');
            updateSystemStatus('Connected - Ready for identification', 'success');
        })
        .catch((error) => {
            console.error('Failed to connect:', error);
            updateSystemStatus('Server not available', 'error');
        });
});

function updateSystemStatus(message, level = 'info') {
    const statusEl = document.getElementById('stage1Status');
    if (!statusEl) return;
    
    const colors = {
        'success': 'palegreen',
        'warning': 'lightyellow',
        'error': 'mistyrose',
        'info': 'lightcyan'
    };
    
    statusEl.style.backgroundColor = colors[level] || colors['info'];
    statusEl.textContent = message;
}

console.log('Two-stage client loaded');

