Set-Location $PSScriptRoot
if (-not (Test-Path ./venv)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    python -m venv venv
}
./venv/Scripts/activate
pip install -r requirements.txt --quiet
Write-Host "Starting uvicorn server..." -ForegroundColor Green
python -m uvicorn main:app --reload
