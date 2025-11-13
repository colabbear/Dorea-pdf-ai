# Modified by colabbear

# knowledge_manager.py - RAG 임베딩 및 지식 관리 시스템

import json
import os
import logging
import asyncio
from datetime import datetime
from typing import List, Dict, Optional, Any, Tuple
from pathlib import Path

import chromadb
from chromadb.config import Settings
import openai
import httpx
import httpx
import ollama  # ollama 라이브러리 import

# 기존 데이터베이스 모델 import
from database import SessionLocal, EmbeddingSettings, FileEmbedding, User
from sqlalchemy import or_

# 로깅 설정
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class KnowledgeManager:
    """RAG 지식 관리 시스템"""
    
    def __init__(self, chroma_path: str = "/app/DATABASE/chroma_db"):
        self.chroma_path = chroma_path
        self.db = SessionLocal()
        self.chroma_client = chromadb.PersistentClient(
            path=chroma_path,
            settings=Settings(anonymized_telemetry=False)
        )
        # Ollama 비동기 클라이언트 초기화 (환경변수 사용)
        self.ollama_base_url = os.getenv("OLLAMA_API_URL", "http://ollama:11434")
        self.ollama_client = ollama.AsyncClient(host=self.ollama_base_url)
        
        # 배치 지원 캐시 (모델별로 한 번만 테스트)
        self.batch_support_cache = {}
        
    async def get_user_settings(self, user_id: int) -> Optional[Dict]:
        """사용자 임베딩 설정 조회"""
        settings = self.db.query(EmbeddingSettings).filter_by(user_id=user_id).first()
        if settings:
            return {
                'provider': settings.provider,
                'model_name': settings.model_name,
                'base_url' : settings.base_url,
                'updated_at': settings.updated_at
            }
        return None
    
    async def _get_user_openai_key(self, user_id: int) -> Optional[str]:
        """사용자의 OpenAI API 키 조회"""
        if not user_id:
            return None
            
        user = self.db.query(User).filter_by(id=user_id).first()
        if user and user.api_key:
            return user.api_key
        return None
    
    async def _get_user_openai_url(self, user_id: int) -> Optional[str]:
        """사용자의 External API url 조회"""
        if not user_id:
            return None
            
        settings = self.db.query(EmbeddingSettings).filter_by(user_id=user_id).first()
        if settings and settings.base_url:
            return settings.base_url
        return None
    
    async def save_user_settings(self, user_id: int, provider: str, model_name: str, base_url: Optional[str] = None) -> bool:
        """사용자 임베딩 설정 저장"""
        try:
            settings = self.db.query(EmbeddingSettings).filter_by(user_id=user_id).first()
            
            if settings:
                settings.provider = provider
                settings.model_name = model_name
                settings.base_url = base_url
                settings.updated_at = datetime.utcnow()
            else:
                settings = EmbeddingSettings(
                    user_id=user_id,
                    provider=provider,
                    model_name=model_name,
                    base_url=base_url
                )
                self.db.add(settings)
            
            self.db.commit()
            logger.info(f"사용자 {user_id} 임베딩 설정 저장: {provider}/{model_name}")
            return True
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"설정 저장 실패: {e}")
            return False
    
    async def test_embedding_model(self, provider: str, model_name: str, user_id: int = None) -> Tuple[bool, str]:
        """임베딩 모델 테스트"""
        test_text = "This is a test sentence for embedding."
        
        try:
            if provider == 'ollama':
                return await self._test_ollama_embedding(model_name, test_text)
            elif provider == 'openai':
                return await self._test_openai_embedding(model_name, test_text, user_id)
            else:
                return False, f"지원하지 않는 provider: {provider}"
                
        except Exception as e:
            logger.error(f"모델 테스트 실패: {e}")
            return False, str(e)
    
    async def _test_ollama_embedding(self, model_name: str, text: str) -> Tuple[bool, str]:
        """Ollama 임베딩 모델 테스트 (ollama 라이브러리 사용)"""
        try:
            result = await self.ollama_client.embeddings(
                model=model_name,
                prompt=text
            )
            embedding = result.get('embedding')
            if embedding and len(embedding) > 0:
                return True, f"모델 테스트 성공: {len(embedding)}차원 벡터 생성"
            else:
                return False, "임베딩 벡터가 비어있습니다"
        except ollama.ResponseError as e:
            logger.error(f"Ollama API 오류: {e.status_code} - {e.error}")
            if e.status_code == 404:
                return False, f"Ollama 모델 '{model_name}'을(를) 찾을 수 없습니다."
            return False, f"Ollama API 오류: {e.error}"
        except Exception as e:
            logger.error(f"Ollama 테스트 중 알 수 없는 오류: {e}")
            return False, f"Ollama 테스트 중 오류: {str(e)}"
    
    async def _test_openai_embedding(self, model_name: str, text: str, user_id: int = None) -> Tuple[bool, str]:
        """OpenAI 임베딩 모델 테스트"""
        try:
            # 사용자 DB에서만 API 키 가져오기
            api_key = await self._get_user_openai_key(user_id)
            if not api_key:
                return False, "OpenAI API 키가 설정되지 않았습니다. 시스템 설정에서 OpenAI API 키를 입력해주세요."

            # 사용자 DB에서 OpenAI 호환 서버 base url 가져오기
            base_url = self._get_user_openai_url(user_id)

            client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url)
            response = await client.embeddings.create(
                model=model_name,
                input=text
            )
            
            embedding = response.data[0].embedding
            if embedding and len(embedding) > 0:
                return True, f"모델 테스트 성공: {len(embedding)}차원 벡터 생성"
            else:
                return False, "임베딩 벡터가 비어있습니다"
                
        except openai.AuthenticationError:
            return False, "OpenAI API 키가 유효하지 않습니다"
        except openai.NotFoundError:
            return False, f"모델 '{model_name}'을 찾을 수 없습니다"
        except Exception as e:
            return False, f"OpenAI 테스트 중 오류: {str(e)}"
    
    async def get_file_embedding_status(self, user_id: int, file_id: str) -> Optional[Dict]:
        """파일의 임베딩 상태 조회"""
        embedding = self.db.query(FileEmbedding).filter_by(
            user_id=user_id, file_id=file_id
        ).first()
        
        if embedding:
            return {
                'file_id': embedding.file_id,
                'filename': embedding.filename,
                'status': embedding.status,
                'total_chunks': embedding.total_chunks,
                'completed_chunks': embedding.completed_chunks,
                'provider': embedding.provider,
                'model_name': embedding.model_name,
                'created_at': embedding.created_at,
                'updated_at': embedding.updated_at,
                'error_message': embedding.error_message,
                'progress': round((embedding.completed_chunks / embedding.total_chunks * 100) 
                                if embedding.total_chunks > 0 else 0, 1)
            }
        return None
    
    async def get_user_embeddings(self, user_id: int) -> List[Dict]:
        """사용자의 모든 파일 임베딩 상태 조회"""
        embeddings = self.db.query(FileEmbedding).filter_by(user_id=user_id).all()
        
        result = []
        for embedding in embeddings:
            progress = round((embedding.completed_chunks / embedding.total_chunks * 100) 
                           if embedding.total_chunks > 0 else 0, 1)
            
            result.append({
                'file_id': embedding.file_id,
                'filename': embedding.filename,
                'status': embedding.status,
                'total_chunks': embedding.total_chunks,
                'completed_chunks': embedding.completed_chunks,
                'provider': embedding.provider,
                'model_name': embedding.model_name,
                'progress': progress,
                'created_at': embedding.created_at,
                'updated_at': embedding.updated_at,
                'error_message': embedding.error_message
            })
        
        return result
    
    def _load_segments_file(self, user_id: int, file_id: str) -> Optional[List[Dict]]:
        """segments.json 파일 로드"""
        base_path = Path("/app/DATABASE/files/users") / str(user_id) / file_id
        segments_files = list(base_path.glob("segments_*.json"))
        if not segments_files:
            logger.error(f"segments 파일을 찾을 수 없습니다: {base_path}")
            return None
        
        segments_file = segments_files[0]
        
        try:
            with open(segments_file, 'r', encoding='utf-8') as f:
                segments = json.load(f)
            logger.info(f"segments 파일 로드 성공: {segments_file}, {len(segments)}개 세그먼트")
            return segments
        except Exception as e:
            logger.error(f"segments 파일 로드 실패: {e}")
            return None
    
    def _filter_valid_segments(self, segments: List[Dict]) -> List[Dict]:
        """임베딩할 유효한 세그먼트 필터링"""
        valid_segments = [s for s in segments if s.get('text', '').strip() and s.get('type') not in ['Page header', 'Page footer']]
        logger.info(f"유효한 세그먼트: {len(valid_segments)}개 (전체: {len(segments)}개)")
        return valid_segments
    
    async def create_file_embedding(self, user_id: int, file_id: str, filename: str) -> bool:
        """파일의 임베딩 생성"""
        try:
            settings = await self.get_user_settings(user_id)
            if not settings:
                logger.error(f"사용자 {user_id}의 임베딩 설정이 없습니다")
                return False
            
            segments = self._load_segments_file(user_id, file_id)
            if not segments: return False
            
            valid_segments = self._filter_valid_segments(segments)
            if not valid_segments: 
                logger.error("임베딩할 유효한 세그먼트가 없습니다")
                return False
            
            await self._init_file_embedding_status(
                user_id, file_id, filename, len(valid_segments), 
                settings['provider'], settings['model_name']
            )
            
            asyncio.create_task(self._process_embeddings_background(
                user_id, file_id, valid_segments, settings
            ))
            
            return True
        except Exception as e:
            logger.error(f"임베딩 생성 실패: {e}")
            await self._update_embedding_status(file_id, 'failed', error_message=str(e))
            return False
    
    async def _init_file_embedding_status(self, user_id: int, file_id: str, filename: str, 
                                        total_chunks: int, provider: str, model_name: str):
        """파일 임베딩 상태 초기화"""
        try:
            existing = self.db.query(FileEmbedding).filter_by(user_id=user_id, file_id=file_id).first()
            if existing: self.db.delete(existing)
            
            file_embedding = FileEmbedding(
                file_id=file_id, user_id=user_id, filename=filename,
                status='processing', total_chunks=total_chunks, completed_chunks=0,
                provider=provider, model_name=model_name
            )
            self.db.add(file_embedding)
            self.db.commit()
            logger.info(f"파일 임베딩 상태 초기화: {file_id}, {total_chunks}개 청크")
        except Exception as e:
            self.db.rollback()
            logger.error(f"임베딩 상태 초기화 실패: {e}")
            raise
    
    async def _check_cancelled_status(self, file_id: str) -> bool:
        """임베딩 취소 상태 확인"""
        try:
            file_embedding = self.db.query(FileEmbedding).filter_by(file_id=file_id).first()
            if file_embedding and file_embedding.status == 'cancelled':
                logger.info(f"⏹️ 임베딩 취소 감지: {file_id}")
                return True
            return False
        except Exception as e:
            logger.error(f"취소 상태 확인 실패: {e}")
            return False

    async def _process_embeddings_background(self, user_id: int, file_id: str, 
                                           segments: List[Dict], settings: Dict):
        """백그라운드에서 임베딩 처리 (취소 지원)"""
        try:
            logger.info(f"임베딩 처리 시작: {file_id}, {len(segments)}개 세그먼트")
            provider = settings['provider']
            collection_name = f"user_{user_id}_documents_{provider}"
            collection = self._get_or_create_collection(collection_name)
            await self._delete_file_chunks_from_chroma(collection, file_id)
            model_name = settings['model_name']
            batch_size = 128 if provider == 'openai' else 20  # Ollama 배치 크기 테스트
            
            # 페이지별 인덱스 추적을 위한 딕셔너리
            page_indices = {}
            
            for i in range(0, len(segments), batch_size):
                # 취소 상태 체크
                if await self._check_cancelled_status(file_id):
                    logger.info(f"⏹️ 임베딩 처리 중단됨: {file_id}")
                    return
                batch_segments = segments[i:i + batch_size]
                batch_texts = [s['text'] for s in batch_segments]
                
                try:
                    result = await self._generate_batch_embeddings(
                        provider, model_name, batch_texts, user_id
                    )
                    
                    # 청킹 결과 처리
                    if provider == 'ollama' and isinstance(result, tuple) and len(result) == 3:
                        # 청킹된 결과: (embeddings, chunk_mapping, chunks)
                        batch_embeddings, chunk_mapping, chunk_texts = result
                        
                        # 청크별 ID와 메타데이터 생성 (원본 복사 + 내용만 수정)
                        chunk_ids = []
                        chunk_metadatas = []
                        chunk_index = 0
                        
                        for j, segment in enumerate(batch_segments):
                            # 페이지별 상대 인덱스 계산
                            page_num = int(segment.get('page_number', 1))
                            if page_num not in page_indices:
                                page_indices[page_num] = 0
                            page_relative_index = page_indices[page_num]
                            page_indices[page_num] += 1
                            
                            orig_chunks_count = chunk_mapping.count(j)
                            for k in range(orig_chunks_count):
                                chunk_ids.append(f"{file_id}_{i+j}_{k}")
                                
                                # 원본 메타데이터 복사 후 청크별 수정
                                metadata = {
                                    'file_id': file_id, 
                                    'user_id': str(user_id),
                                    'chunk_index': i+j, 
                                    'sub_chunk': k,
                                    'segment_id': segment.get('id') or f"page{page_num}_{page_relative_index}",
                                    'segment_type': segment.get('type', 'text'),
                                    'page_number': page_num,
                                    'text_length': len(chunk_texts[chunk_index + k])
                                }
                                # 원본 segment의 다른 필드들도 복사
                                for key, value in segment.items():
                                    if key not in ['text'] and key not in metadata:
                                        metadata[key] = value
                                        
                                chunk_metadatas.append(metadata)
                            chunk_index += orig_chunks_count
                        
                        logger.info(f"🔍 청킹 임베딩 결과: {len(batch_embeddings)}개 청크 (원본 {len(batch_texts)}개)")
                        
                        # ChromaDB에 청크별로 저장
                        try:
                            collection.add(embeddings=batch_embeddings, documents=chunk_texts, ids=chunk_ids, metadatas=chunk_metadatas)
                            await self._update_embedding_progress(file_id, i + len(batch_segments))
                            logger.info(f"배치 {i+1}-{i+len(batch_segments)}/{len(segments)} 청킹 임베딩 완료: {file_id}")
                        except Exception as chroma_error:
                            logger.error(f"ChromaDB 저장 실패: {chroma_error}")
                            if "dimension" in str(chroma_error).lower():
                                logger.warning(f"임베딩 차원 불일치로 컬렉션 재생성: {collection_name}")
                                self.chroma_client.delete_collection(collection_name)
                                collection = self._get_or_create_collection(collection_name)
                                collection.add(embeddings=batch_embeddings, documents=chunk_texts, ids=chunk_ids, metadatas=chunk_metadatas)
                            else:
                                raise chroma_error
                            await self._update_embedding_progress(file_id, i + len(batch_segments))
                            logger.info(f"배치 {i+1}-{i+len(batch_segments)}/{len(segments)} 청킹 임베딩 완료 (컬렉션 재생성): {file_id}")
                            
                    else:
                        # 일반 배치 결과 처리
                        batch_embeddings = result
                        logger.info(f"🔍 배치 임베딩 결과: {len(batch_embeddings) if batch_embeddings else 'None'}, 예상: {len(batch_texts)}")
                        
                        if not batch_embeddings or len(batch_embeddings) != len(batch_texts):
                            logger.error(f"❌ 배치 {i}-{i+batch_size} 임베딩 결과 길이 불일치")
                            continue

                        chunk_ids = [f"{file_id}_{i+j}" for j in range(len(batch_segments))]
                        metadatas = []
                        for j, s in enumerate(batch_segments):
                            # 페이지별 상대 인덱스 계산
                            page_num = int(s.get('page_number', 1))
                            if page_num not in page_indices:
                                page_indices[page_num] = 0
                            page_relative_index = page_indices[page_num]
                            page_indices[page_num] += 1
                            
                            metadatas.append({
                                'file_id': file_id, 'user_id': str(user_id),
                                'chunk_index': i+j, 
                                'segment_id': s.get('id') or f"page{page_num}_{page_relative_index}",
                                'segment_type': s.get('type', 'text'),
                                'page_number': page_num,
                                'text_length': len(s['text'])
                            })

                        try:
                            collection.add(embeddings=batch_embeddings, documents=batch_texts, ids=chunk_ids, metadatas=metadatas)
                            await self._update_embedding_progress(file_id, i + len(batch_segments))
                            logger.info(f"배치 {i+1}-{i+len(batch_segments)}/{len(segments)} 임베딩 완료: {file_id}")
                        except Exception as chroma_error:
                            logger.error(f"ChromaDB 저장 실패: {chroma_error}")
                            if "dimension" in str(chroma_error).lower():
                                logger.warning(f"임베딩 차원 불일치로 컬렉션 재생성: {collection_name}")
                                self.chroma_client.delete_collection(collection_name)
                                collection = self._get_or_create_collection(collection_name)
                                collection.add(embeddings=batch_embeddings, documents=batch_texts, ids=chunk_ids, metadatas=metadatas)
                            else:
                                raise chroma_error
                            await self._update_embedding_progress(file_id, i + len(batch_segments))
                            logger.info(f"배치 {i+1}-{i+len(batch_segments)}/{len(segments)} 임베딩 완료 (컬렉션 재생성): {file_id}")

                except Exception as e:
                    logger.error(f"배치 {i}-{i+batch_size} 임베딩 실패: {e}")
                
                await asyncio.sleep(0.05)
            
            await self._update_embedding_status(file_id, 'completed')
            logger.info(f"파일 임베딩 완료: {file_id}")
        except Exception as e:
            logger.error(f"백그라운드 임베딩 처리 실패: {e}")
            await self._update_embedding_status(file_id, 'failed', error_message=str(e))
    
    async def _update_embedding_progress(self, file_id: str, completed_chunks: int):
        """임베딩 진행률 업데이트"""
        try:
            file_embedding = self.db.query(FileEmbedding).filter_by(file_id=file_id).first()
            if file_embedding:
                file_embedding.completed_chunks = completed_chunks
                file_embedding.updated_at = datetime.utcnow()
                self.db.commit()
                
                # 진행률 계산 및 로그
                progress = round((completed_chunks / file_embedding.total_chunks * 100), 1)
                logger.info(f"📊 DB 진행률 업데이트: {file_id} → {completed_chunks}/{file_embedding.total_chunks} ({progress}%)")
        except Exception as e:
            self.db.rollback()
            logger.error(f"진행률 업데이트 실패: {e}")

    async def _update_embedding_status(self, file_id: str, status: str, error_message: str = None):
        """임베딩 상태 업데이트"""
        try:
            file_embedding = self.db.query(FileEmbedding).filter_by(file_id=file_id).first()
            if file_embedding:
                file_embedding.status = status
                file_embedding.updated_at = datetime.utcnow()
                if error_message: file_embedding.error_message = error_message
                if status == 'completed':
                    file_embedding.completed_chunks = file_embedding.total_chunks
                self.db.commit()
                logger.info(f"상태 업데이트: {file_id} -> {status}")
        except Exception as e:
            self.db.rollback()
            logger.error(f"상태 업데이트 실패: {e}")

    def _get_or_create_collection(self, collection_name: str):
        """ChromaDB 컬렉션 가져오기 또는 생성"""
        try:
            return self.chroma_client.get_collection(collection_name)
        except ValueError:
            return self.chroma_client.create_collection(name=collection_name)
    
    async def _generate_batch_embeddings(self, provider: str, model_name: str, 
                                       texts: List[str], user_id: int) -> Optional[List[List[float]]]:
        """배치 텍스트 임베딩 생성"""
        try:
            if provider == 'ollama':
                return await self._generate_ollama_batch_embeddings(model_name, texts)
            elif provider == 'openai':
                return await self._generate_openai_batch_embeddings(model_name, texts, user_id)
            return None
        except Exception as e:
            logger.error(f"배치 임베딩 생성 실패: {e}")
            return None

    async def _generate_embedding(self, provider: str, model_name: str, 
                                text: str, user_id: int) -> Optional[List[float]]:
        """단일 텍스트 임베딩 생성"""
        batch_result = await self._generate_batch_embeddings(provider, model_name, [text], user_id)
        
        # Ollama 청킹 결과 처리
        if isinstance(batch_result, tuple) and len(batch_result) == 3:
            embeddings, chunk_mapping, chunks = batch_result
            # 첫 번째 텍스트의 첫 번째 청크 임베딩 반환
            return embeddings[0] if embeddings else None
        
        # 일반 배치 결과 처리
        return batch_result[0] if batch_result else None
    
    async def _generate_openai_batch_embeddings(self, model_name: str, texts: List[str], user_id: int) -> Optional[List[List[float]]]:
        """OpenAI로 배치 임베딩 생성"""
        try:
            api_key = await self._get_user_openai_key(user_id)
            if not api_key: raise ValueError("OpenAI API 키가 설정되지 않았습니다")

            base_url = await self._get_user_openai_url(user_id)
            
            client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url)
            response = await client.embeddings.create(model=model_name, input=texts)
            return [data.embedding for data in response.data]
        except Exception as e:
            logger.error(f"OpenAI 배치 임베딩 생성 중 오류: {e}")
            return None

    async def _get_ollama_model_context_length(self, model_name: str) -> int:
        """Ollama 모델의 최대 컨텍스트 길이 확인"""
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "http://ollama:11434/api/show",
                    json={"name": model_name}
                )
                if response.status_code == 200:
                    model_info = response.json()
                    # model_info에서 context_length 찾기
                    if "model_info" in model_info:
                        context_length = model_info["model_info"].get("bert.context_length")
                        if context_length:
                            return int(context_length)
                    return 512  # 기본값
                return 512
        except Exception as e:
            logger.warning(f"모델 컨텍스트 길이 확인 실패, 기본값 512 사용: {e}")
            return 512

    def _chunk_text(self, text: str, max_chars: int) -> List[str]:
        """긴 텍스트를 청킹 처리 (겹침 포함)"""
        if len(text) <= max_chars:
            return [text]
        
        chunks = []
        overlap = int(max_chars * 0.1)  # 10% 겹침
        start = 0
        
        while start < len(text):
            end = start + max_chars
            if end >= len(text):
                chunks.append(text[start:])
                break
            
            # 단어 경계에서 자르기 시도
            chunk = text[start:end]
            last_space = chunk.rfind(' ')
            if last_space > max_chars * 0.8:  # 80% 이상 위치에서 공백 발견
                end = start + last_space
            
            chunks.append(text[start:end])
            start = end - overlap
        
        return chunks

    async def _generate_ollama_batch_embeddings(self, model_name: str, texts: List[str]) -> Optional[List[List[float]]]:
        """Ollama 임베딩 생성 (긴 텍스트 청킹 포함)"""
        try:
            # 모델의 실제 토큰 제한 확인
            max_tokens = await self._get_ollama_model_context_length(model_name)
            max_chars = int(max_tokens * 0.8)
            
            # 텍스트 청킹 처리
            all_chunks = []
            chunk_mapping = []  # 원본 텍스트 인덱스 매핑
            
            for i, text in enumerate(texts):
                chunks = self._chunk_text(text, max_chars)
                all_chunks.extend(chunks)
                chunk_mapping.extend([i] * len(chunks))
                
                if len(chunks) > 1:
                    logger.info(f"📝 텍스트 {i+1} 청킹: {len(text)}자 → {len(chunks)}개 청크")
            
            logger.info(f"🔄 Ollama 배치 처리: {len(texts)}개 텍스트 → {len(all_chunks)}개 청크")
            
            # 청크들을 배치 처리
            chunk_embeddings = []
            batch_size = 20  # 청크 배치 크기
            
            for i in range(0, len(all_chunks), batch_size):
                batch_chunks = all_chunks[i:i + batch_size]
                
                try:
                    async with httpx.AsyncClient() as client:
                        response = await client.post(
                            f"{self.ollama_base_url}/api/embed",
                            json={
                                "model": model_name,
                                "input": batch_chunks
                            },
                            timeout=60.0
                        )
                        response.raise_for_status()
                        response_data = response.json()
                    
                    embeddings = response_data.get("embeddings", [])
                    if embeddings and len(embeddings) == len(batch_chunks):
                        chunk_embeddings.extend(embeddings)
                        logger.info(f"✅ 청크 배치 처리 성공: {len(embeddings)}개")
                    else:
                        logger.warning(f"❌ 청크 배치 응답 길이 불일치")
                        return None
                        
                except Exception as batch_error:
                    logger.warning(f"❌ 청크 배치 처리 실패: {batch_error}")
                    return None
            
            # 각 청크를 독립적인 임베딩으로 반환 (의미 보존)
            logger.info(f"✅ 청킹 처리 완료: {len(chunk_embeddings)}개 청크 임베딩 (원본 {len(texts)}개 텍스트)")
            return chunk_embeddings, chunk_mapping, all_chunks  # 청크 정보도 함께 반환

        except Exception as e:
            logger.error(f"Ollama 임베딩 생성 실패: {e}")
            return await self._generate_ollama_individual_embeddings(model_name, texts)
    
    async def _generate_ollama_individual_embeddings(self, model_name: str, texts: List[str]) -> Optional[List[List[float]]]:
        """Ollama 개별 처리 (폴백용)"""
        try:
            max_tokens = await self._get_ollama_model_context_length(model_name)
            max_chars = int(max_tokens * 0.8)
            
            embeddings = []
            total_texts = len(texts)
            
            for i, text in enumerate(texts):
                truncated_text = text[:max_chars] if len(text) > max_chars else text
                
                try:
                    response = await self.ollama_client.embeddings(
                        model=model_name,
                        prompt=truncated_text
                    )
                    embeddings.append(response["embedding"])
                    logger.info(f"Ollama 개별 임베딩 생성됨 (첫 5개 값): {response['embedding'][:5]}...")
                    
                    # 진행률 로그
                    if (i + 1) % 5 == 0 or i == total_texts - 1:
                        progress = round((i + 1) / total_texts * 100, 1)
                        logger.info(f"Ollama 개별 임베딩 진행: {i + 1}/{total_texts} ({progress}%)")
                    
                except Exception as single_error:
                    logger.error(f"개별 임베딩 {i+1}/{total_texts} 실패: {single_error}")
                    # 실패한 경우 빈 임베딩으로 대체하지 않고 전체 실패 처리
                    return None
                
                # 개별 처리 시 지연 (서버 부하 방지)
                await asyncio.sleep(0.1)
                    
            return embeddings
        except Exception as e:
            logger.error(f"Ollama 개별 임베딩 생성 중 오류: {e}")
            return None

    async def cancel_file_embedding(self, user_id: int, file_id: str) -> bool:
        """파일의 임베딩 처리 취소"""
        try:
            file_embedding = self.db.query(FileEmbedding).filter_by(user_id=user_id, file_id=file_id).first()
            if not file_embedding or file_embedding.status != 'processing':
                return False
            
            file_embedding.status = 'cancelled'
            file_embedding.updated_at = datetime.utcnow()
            file_embedding.error_message = '사용자에 의해 취소됨'
            self.db.commit()
            
            # 파일의 임베딩 프로바이더 정보 가져오기
            embedding_provider = file_embedding.provider if file_embedding.provider else 'ollama'
            collection_name = f"user_{user_id}_documents_{embedding_provider}"
            try:
                collection = self.chroma_client.get_collection(collection_name)
                await self._delete_file_chunks_from_chroma(collection, file_id)
            except ValueError:
                logger.warning(f"ChromaDB 컬렉션 {collection_name} 정리 중 찾을 수 없음 (무시)")
            
            logger.info(f"임베딩 취소 완료: {file_id}")
            return True
        except Exception as e:
            self.db.rollback()
            logger.error(f"임베딩 취소 실패: {e}")
            return False
    
    async def _delete_file_chunks_from_chroma(self, collection, file_id: str):
        """ChromaDB에서 파일의 기존 청크들 삭제"""
        results = collection.get(where={"file_id": file_id}, include=[])
        if results['ids']:
            collection.delete(ids=results['ids'])
            logger.info(f"기존 임베딩 삭제: {file_id}, {len(results['ids'])}개")
    
    async def _check_embedding_consistency(self, user_id: int, current_settings: Dict, file_id: str = None) -> List[Dict]:
        """임베딩 모델 통일성 체크"""
        try:
            # 특정 파일만 체크하는 경우
            if file_id:
                embedding = self.db.query(FileEmbedding).filter_by(
                    user_id=user_id, file_id=file_id, status='completed'
                ).first()
                
                if embedding and (embedding.provider != current_settings['provider'] or 
                                embedding.model_name != current_settings['model_name']):
                    return [{
                        'file_id': embedding.file_id,
                        'filename': embedding.filename,
                        'existing_model': f"{embedding.provider}:{embedding.model_name}",
                        'current_model': f"{current_settings['provider']}:{current_settings['model_name']}"
                    }]
                return []
            
            # 전체 파일 체크
            inconsistent_embeddings = self.db.query(FileEmbedding).filter(
                FileEmbedding.user_id == user_id,
                FileEmbedding.status == 'completed',
                or_(
                    FileEmbedding.provider != current_settings['provider'],
                    FileEmbedding.model_name != current_settings['model_name']
                )
            ).all()
            
            result = []
            for embedding in inconsistent_embeddings:
                result.append({
                    'file_id': embedding.file_id,
                    'filename': embedding.filename,
                    'existing_model': f"{embedding.provider}:{embedding.model_name}",
                    'current_model': f"{current_settings['provider']}:{current_settings['model_name']}"
                })
            
            return result
        except Exception as e:
            logger.error(f"임베딩 통일성 체크 실패: {e}")
            return []
    
    async def reembed_inconsistent_files(self, user_id: int) -> Dict[str, Any]:
        """모델 불일치 파일들 재임베딩"""
        try:
            settings = await self.get_user_settings(user_id)
            if not settings:
                return {"success": False, "message": "임베딩 설정이 없습니다"}
            
            inconsistent_files = await self._check_embedding_consistency(user_id, settings)
            if not inconsistent_files:
                return {"success": True, "message": "재임베딩이 필요한 파일이 없습니다", "count": 0}
            
            success_count = 0
            failed_files = []
            
            for file_info in inconsistent_files:
                file_id = file_info['file_id']
                filename = file_info['filename']
                
                try:
                    # 기존 임베딩 삭제 후 재생성
                    await self.delete_file_embedding(user_id, file_id)
                    success = await self.create_file_embedding(user_id, file_id, filename)
                    
                    if success:
                        success_count += 1
                        logger.info(f"✅ 재임베딩 시작: {filename}")
                    else:
                        failed_files.append(filename)
                        logger.error(f"❌ 재임베딩 실패: {filename}")
                        
                except Exception as e:
                    failed_files.append(filename)
                    logger.error(f"❌ 재임베딩 오류: {filename} - {e}")
            
            message = f"{success_count}개 파일의 재임베딩을 시작했습니다."
            if failed_files:
                message += f" (실패: {len(failed_files)}개)"
            
            return {
                "success": True, 
                "message": message,
                "count": success_count,
                "failed_files": failed_files
            }
            
        except Exception as e:
            logger.error(f"일괄 재임베딩 실패: {e}")
            return {"success": False, "message": f"재임베딩 중 오류 발생: {str(e)}"}

    async def delete_file_embedding(self, user_id: int, file_id: str) -> bool:
        """파일의 임베딩 삭제"""
        try:
            # 파일의 임베딩 프로바이더 정보 가져오기
            file_embedding = self.db.query(FileEmbedding).filter_by(user_id=user_id, file_id=file_id).first()
            embedding_provider = file_embedding.provider if file_embedding and file_embedding.provider else 'ollama'
            collection_name = f"user_{user_id}_documents_{embedding_provider}"
            try:
                collection = self.chroma_client.get_collection(collection_name)
                await self._delete_file_chunks_from_chroma(collection, file_id)
            except ValueError:
                logger.warning(f"ChromaDB 컬렉션 {collection_name} 삭제 중 찾을 수 없음 (무시)")
            
            self.db.query(FileEmbedding).filter_by(user_id=user_id, file_id=file_id).delete()
            self.db.commit()
            logger.info(f"파일 임베딩 삭제 완료: {file_id}")
            return True
        except Exception as e:
            self.db.rollback()
            logger.error(f"파일 임베딩 삭제 실패: {e}")
            return False
    
    async def search_similar_documents(self, user_id: int, query: str, 
                                     top_k: int = 5, file_id: str = None) -> List[Dict]:
        """유사 문서 검색 (선택적으로 특정 파일로 제한)"""
        try:
            embedding_provider = None
            embedding_model = None

            if file_id:
                # 특정 파일 검색 시, 해당 파일의 임베딩 모델 사용
                file_embedding_info = await self.get_file_embedding_status(user_id, file_id)
                if file_embedding_info and file_embedding_info['status'] == 'completed':
                    embedding_provider = file_embedding_info['provider']
                    embedding_model = file_embedding_info['model_name']
                    logger.info(f"📄 파일별 검색: '{file_embedding_info['filename']}'의 임베딩 모델({embedding_provider}/{embedding_model})을 사용합니다.")
                else:
                    logger.warning(f"⚠️ 해당 파일({file_id})의 임베딩 정보를 찾을 수 없거나 완료되지 않았습니다.")
                    return []
            
            if not embedding_provider or not embedding_model:
                # 전역 설정 사용 (파일 ID가 없거나, 파일 정보를 가져오지 못한 경우)
                settings = await self.get_user_settings(user_id)
                if not settings: 
                    logger.error(f"❌ 사용자 {user_id}의 임베딩 설정이 없습니다. RAG 검색을 위해서는 먼저 임베딩 모델을 설정해주세요.")
                    return []
                embedding_provider = settings['provider']
                embedding_model = settings['model_name']
                logger.info(f"⚙️ 전역 검색: 현재 설정된 임베딩 모델({embedding_provider}/{embedding_model})을 사용합니다.")

                # 전역 검색 시에만 모델 불일치 검사 수행
                inconsistent_files = await self._check_embedding_consistency(user_id, settings)
                if inconsistent_files:
                    logger.warning(f"⚠️ 전역 설정과 다른 임베딩 모델을 사용하는 파일이 {len(inconsistent_files)}개 있습니다.")
                    return [{
                        "type": "embedding_inconsistency_warning", 
                        "inconsistent_files": inconsistent_files,
                        "current_model": f"{settings['provider']}:{settings['model_name']}",
                        "message": f"현재 설정된 임베딩 모델과 다른 모델로 임베딩된 파일들이 있습니다."
                    }]

            query_embedding = await self._generate_embedding(
                embedding_provider, embedding_model, query, user_id
            )
            if not query_embedding: 
                logger.error(f"❌ 질문 임베딩 생성 실패: query='{query}', provider={embedding_provider}, model={embedding_model}")
                return []
            
            if not isinstance(query_embedding, list) or not query_embedding:
                logger.error(f"❌ 잘못된 임베딩 형식: {type(query_embedding)}")
                return []
            
            logger.info(f"✅ 질문 임베딩 생성 성공: 차원={len(query_embedding)}")
            
            collection_name = f"user_{user_id}_documents_{embedding_provider}"
            try:
                collection = self.chroma_client.get_collection(collection_name)
                
                # 컬렉션 전체 데이터 개수 확인
                total_count = collection.count()
                logger.info(f"📊 컬렉션 '{collection_name}' 전체 문서 개수: {total_count}")
                
                # 해당 파일의 데이터 개수 확인
                if file_id:
                    file_results = collection.get(where={"file_id": file_id}, include=[])
                    file_count = len(file_results['ids']) if file_results['ids'] else 0
                    logger.info(f"📄 파일 '{file_id}'의 임베딩 개수: {file_count}")
                    
                    if file_count == 0:
                        logger.warning(f"⚠️ 파일 '{file_id}'의 임베딩이 ChromaDB에 없습니다. 임베딩 처리가 완료되었는지 확인하세요.")
                        
            except ValueError: 
                logger.error(f"❌ 컬렉션 '{collection_name}'을 찾을 수 없습니다.")
                return []
            
            where_filter = {"file_id": file_id} if file_id else None
            logger.info(f"🔍 ChromaDB 검색 조건: collection={collection_name}, filter={where_filter}")
            
            results = collection.query(
                query_embeddings=[query_embedding], 
                n_results=top_k,
                where=where_filter
            )
            logger.info(f"🔍 ChromaDB 원시 결과: documents={len(results.get('documents', [[]])[0])}, ids={results.get('ids', [[]])}")
            
            return [{
                'text': doc,
                'distance': dist,
                'metadata': meta,
                'id': id
            } for doc, dist, meta, id in zip(results['documents'][0], results['distances'][0], results['metadatas'][0], results['ids'][0])]
        except Exception as e:
            logger.error(f"문서 검색 실패: {e}")
            return []
    
    def close(self):
        """리소스 정리"""
        self.db.close()

knowledge_manager = KnowledgeManager()