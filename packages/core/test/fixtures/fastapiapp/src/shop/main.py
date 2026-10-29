import time

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from shop import legacy
from shop.deps import NotSignedIn
from shop.routers import items_router
from shop.settings import settings

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"])


@app.middleware("http")
async def timing(request, call_next):
    if request.headers.get("x-blocked"):
        return JSONResponse({"error": "blocked"}, 403)
    started = time.monotonic()
    response = await call_next(request)
    response.headers["x-time"] = str(time.monotonic() - started)
    return response


@app.exception_handler(NotSignedIn)
async def not_signed_in(request, error):
    return JSONResponse({"error": "sign in"}, 401)


app.include_router(items_router, prefix=settings.API_PREFIX)
app.router.routes.extend(legacy.routes())


@app.websocket("/ws")
async def feed(websocket: WebSocket):
    token = websocket.query_params.get("token")
    await websocket.accept()
