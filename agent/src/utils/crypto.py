"""截图加密工具模块

使用 RSA+AES 混合加密保护截图数据：
- 每张截图生成随机 AES-256 密钥和 IV
- 用 AES-256-CBC 加密 JPEG 数据
- 用 Server RSA 公钥加密 AES 密钥+IV
- 文件格式：[4字节大端RSA块长度][RSA加密块][AES加密数据]

Client 机器上没有 RSA 私钥，无法解密。
"""
import os
import struct
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.backends import default_backend

# AES 密钥长度（32 字节 = AES-256）
AES_KEY_SIZE = 32
# AES IV 长度（16 字节）
AES_IV_SIZE = 16
# RSA 加密块包含 AES 密钥 + IV = 48 字节
RSA_PLAINTEXT_SIZE = AES_KEY_SIZE + AES_IV_SIZE


def encrypt_screenshot(jpeg_bytes: bytes, public_key_pem: str) -> bytes:
    """加密截图 JPEG 数据。

    Args:
        jpeg_bytes: 原始 JPEG 二进制数据
        public_key_pem: PEM 格式的 RSA 公钥字符串

    Returns:
        加密后的二进制数据，格式为：
        [4字节大端RSA块长度][RSA加密块][AES加密数据]
    """
    # 加载公钥
    public_key = serialization.load_pem_public_key(
        public_key_pem.encode(), backend=default_backend()
    )

    # 生成随机 AES 密钥和 IV
    aes_key = os.urandom(AES_KEY_SIZE)
    iv = os.urandom(AES_IV_SIZE)

    # AES-256-CBC 加密 JPEG 数据（PKCS7 padding）
    cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    # PKCS7 padding
    pad_len = 16 - (len(jpeg_bytes) % 16)
    padded = jpeg_bytes + bytes([pad_len] * pad_len)
    aes_encrypted = encryptor.update(padded) + encryptor.finalize()

    # RSA-OAEP 加密 AES 密钥 + IV
    rsa_plaintext = aes_key + iv
    rsa_encrypted = public_key.encrypt(
        rsa_plaintext,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    # 拼装：[4字节大端RSA块长度][RSA加密块][AES加密数据]
    rsa_len = len(rsa_encrypted)
    header = struct.pack('>I', rsa_len)
    return header + rsa_encrypted + aes_encrypted
