print("SERVER APP BERJALAN")
#import firebase_admin
from flask import Flask, request, jsonify, render_template, send_from_directory
#from firebase_admin import credentials
#from firebase_admin import messaging
from flask_cors import CORS
import time
import os
import json
import pandas as pd
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static')
    
)
CORS(app)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


print("⚠ Firebase sementara dimatikan")
# FILE CSV
# =========================
DATA_DIR = "data"
CSV_FILE = os.path.join(DATA_DIR, "data.csv")
TEST_DIR = os.path.join(DATA_DIR, "pengujian")

os.makedirs(TEST_DIR, exist_ok=True)

os.makedirs(DATA_DIR, exist_ok=True)

# buat csv jika belum ada
if not os.path.exists(CSV_FILE):
    df = pd.DataFrame(columns=[
    "timestamp",
    "voltage",
    "current",
    "power",
    "frequency",
    "pf",
    "kwh",

    "status",
    "confidence",
    
    "deltaPower",
    "deltaPowerRate",
    "temporalStatus",

    "cycleCount",
    "deviceCycling",

    "relay",
    "pln"
])
    df.to_csv(CSV_FILE, index=False)
# =========================
# WAKTU TERAKHIR DATA
# =========================
last_update = 0

# =========================
# DATA REALTIME
# =========================
latest_data = {
    "voltage": 0,
    "current": 0,
    "power": 0,
    "frequency": 0,
    "pf": 0,
    "kwh": 0,

    "status": "OFFLINE",
    "confidence": 0,

    "relay": False,
    "pln": False,

    "deltaPower": 0,
    "deltaPowerRate": 0,
    "temporal": "NORMAL",
    "deviceCycling": False
}
# =========================
# SETTINGS GLOBAL
# =========================
SETTINGS = {
    "warnPower": 1000,
    "highPower": 2200,
    "shortPower": 3000
}
RESET_PROTEKSI = False
# =========================
# HOME
# =========================
@app.route('/')
def home():
    return render_template('index.html')

# =========================
# DASHBOARD
# =========================
@app.route('/dashboard')
def dashboard():
    return render_template('index.html')

# =========================
# API LATEST
# =========================
@app.route('/api/latest')
def api_latest():
    global latest_data, last_update

    # ESP benar-benar offline
    if time.time() - last_update > 10:

        return jsonify({
            "voltage": 0,
            "current": 0,
            "power": 0,
            "frequency": 0,
            "pf": 0,
            "kwh": 0,
            "status": "ESP_OFFLINE",
            "relay": False,
            "pln": False
        })

    # kalau data masih masuk
    data = latest_data.copy()

    # PLN mati tapi ESP masih online
    if data.get("voltage", 0) < 10:
        data["status"] = "PLN_OFFLINE"
        data["pln"] = False
    else:
        data["pln"] = True

    return jsonify(data)

# =========================
# API UPDATE
# =========================
@app.route('/api/update', methods=['POST'])
def api_update():
    global latest_data, last_update

    try:
        data = request.json

        print("📥 DATA MASUK:", data)
        
    
        latest_data = {
            "voltage": data.get("voltage", 0),
            "current": data.get("current", 0),
            "power": data.get("power", 0),
            "frequency": data.get("frequency", 50),
            "pf": data.get("pf", 0),
            "kwh": data.get("kwh", 0),

            "status": data.get("status", "NORMAL"),
            "confidence": data.get("confidence", 0),

            "relay": data.get("relay", True),
            "pln": data.get("pln", True),

            "deltaPower": data.get("deltaPower", 0),
            "deltaPowerRate": data.get("deltaPowerRate", 0),
            "temporal": data.get("temporal", "NORMAL"),
            "deviceCycling": data.get("deviceCycling", False)
        }

        last_update = time.time()

        # =========================
        # SIMPAN CSV
        # =========================
        row = {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            **latest_data
        }

        print("💾 MENYIMPAN CSV:", row)

        pd.DataFrame([row]).to_csv(
            CSV_FILE,
            mode='a',
            header=not os.path.exists(CSV_FILE),
            index=False
        )

        print("✅ CSV BERHASIL DISIMPAN")

        return jsonify({
            "success": True,
            "message": "Data updated",
            "data": latest_data
        })

    except Exception as e:
        print("❌ ERROR:", str(e))

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

# =========================
# =========================
# SAVE HASIL PENGUJIAN
# =========================
TEST_DIR = os.path.join(DATA_DIR, "pengujian")
os.makedirs(TEST_DIR, exist_ok=True)
# CEK CSV
# =========================
@app.route('/api/csv')
def api_csv():

    try:
        df = pd.read_csv(CSV_FILE)

        return df.tail(20).to_json(
            orient='records',
            indent=2
        )

    except Exception as e:
        return jsonify({
            "error": str(e)
        })

# =========================
# HEALTH
# =========================
# =========================
# GET SETTINGS
# =========================
@app.route('/api/settings')
def get_settings():

    return jsonify(SETTINGS)


# =========================
# SAVE SETTINGS
# =========================
@app.route('/api/settings', methods=['POST'])
def save_settings():

    global SETTINGS

    data = request.json

    SETTINGS["warnPower"] = data.get("warnPower", 1000)
    SETTINGS["highPower"] = data.get("highPower", 2200)
    SETTINGS["shortPower"] = data.get("shortPower", 3000)

    print("SETTINGS UPDATE:", SETTINGS)

    return jsonify({
        "success": True,
        "settings": SETTINGS
    })
# =========================
# RESET PROTEKSI
# =========================
@app.route('/api/reset-proteksi', methods=['POST'])
def reset_proteksi():

    global RESET_PROTEKSI

    RESET_PROTEKSI = True

    print("🔄 RESET PROTEKSI DIMINTA")

    return jsonify({
        "success": True
    })
# =========================
# CEK RESET PROTEKSI
# =========================
@app.route('/api/reset-proteksi')
def get_reset_proteksi():

    global RESET_PROTEKSI

    status = RESET_PROTEKSI

    if RESET_PROTEKSI:
        RESET_PROTEKSI = False

    return jsonify({
        "reset": status
    })

@app.route('/health')
def health():
    return jsonify({
        "status": "healthy"
    })

@app.route('/firebase-messaging-sw.js')
def firebase_sw():
    return send_from_directory(
        app.static_folder,
        'firebase-messaging-sw.js',
        mimetype='application/javascript'
    )

TOKENS = []

@app.route("/save-token", methods=["POST"])
def save_token():

    try:
        data = request.get_json()

        token = data.get("token")

        if token and token not in TOKENS:
            TOKENS.append(token)

            print("✅ TOKEN SAVED:", token)

        return jsonify({
            "success": True
        })

    except Exception as e:

        return jsonify({
            "error": str(e)
        }), 500
    
# =========================
# =========================
# =========================
# SAVE HASIL PENGUJIAN
# =========================
@app.route("/api/save-pengujian", methods=["POST"])
def save_pengujian():

    try:

        data = request.get_json()

        print("========== SAVE PENGUJIAN ==========")

        nama_alat = data.get("namaAlat", "Tanpa_Nama")
        hasil = data.get("data", [])

        print("Nama alat :", nama_alat)
        print("Jumlah data :", len(hasil))

        if len(hasil) > 0:
            print("Baris pertama :", hasil[0])

        folder = os.path.join(DATA_DIR, "pengujian")
        os.makedirs(folder, exist_ok=True)

        nama_file = (
            nama_alat.replace(" ", "_")
            + "_"
            + datetime.now().strftime("%Y%m%d_%H%M%S")
            + ".csv"
        )

        file_path = os.path.join(folder, nama_file)

        df = pd.DataFrame(hasil)

        print(df.head())
        print("Shape :", df.shape)

        df.to_csv(file_path, index=False)

        print("Disimpan ke :", file_path)
        print("✅ HASIL PENGUJIAN DISIMPAN :", file_path)

        return jsonify({
            "success": True,
            "file": nama_file
        })

    except Exception as e:

        print("❌ SAVE ERROR :", e)

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500
# RUN
# =========================
if __name__ == '__main__':

    port = int(os.environ.get("PORT", 5000))

    app.run(
        host='0.0.0.0',
        port=port,
        debug=False
    )