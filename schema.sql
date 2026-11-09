-- 跳一跳 3D 玩家表（服务启动时也会自动执行 CREATE TABLE IF NOT EXISTS，这个文件用于手动建表 / 备查）
CREATE TABLE IF NOT EXISTS players (
  id          CHAR(32)     NOT NULL PRIMARY KEY,          -- 公开的玩家 ID（随机）
  secret_hash CHAR(64)     NOT NULL,                      -- 设备密钥的 SHA-256，只存哈希
  nickname    VARCHAR(24)  NOT NULL,
  best_score  INT          NOT NULL DEFAULT 0,
  perfects    INT          NOT NULL DEFAULT 0,
  games       INT          NOT NULL DEFAULT 0,
  equipped    VARCHAR(32)  NOT NULL DEFAULT 'player:cola',
  unlocked    VARCHAR(600) NOT NULL DEFAULT 'player:cola',  -- 逗号分隔，如 player:cola,player:gold
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_score (best_score DESC)
);
