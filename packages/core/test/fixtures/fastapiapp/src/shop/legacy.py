from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


async def ping(request):
    return JSONResponse({"from": request.client.host, "agent": request.headers.get("user-agent")})


def routes():
    return [Route(path, ping, methods=["GET"]) for path in ("/ping", "/healthz")]
