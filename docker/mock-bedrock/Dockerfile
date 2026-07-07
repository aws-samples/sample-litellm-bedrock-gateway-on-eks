# mock-bedrock —— 极简 stdlib http.server，无第三方依赖。
FROM python:3.12-slim

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
# stdlib only：直接跑，无需 pip install 任何东西。
CMD ["python", "-u", "/app/server.py"]
