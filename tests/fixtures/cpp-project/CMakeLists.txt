cmake_minimum_required(VERSION 3.20)
project(MyApp VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(fmt REQUIRED)
find_package(spdlog REQUIRED)

add_library(engine STATIC
    src/engine.cpp
    src/diesel_engine.cpp
    src/electric_motor.cpp
)
target_include_directories(engine PUBLIC include)
target_link_libraries(engine PUBLIC spdlog::spdlog)

add_executable(myapp src/main.cpp)
target_link_libraries(myapp PRIVATE engine fmt::fmt)

add_library(utils STATIC src/utils.cpp)
target_link_libraries(utils PRIVATE spdlog::spdlog)