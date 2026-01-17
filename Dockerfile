FROM python:3.10-slim

WORKDIR /app

# 安装 Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 复制并安装依赖
COPY package.json ./
RUN npm install

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目文件
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
